# Homenichat fork — patches on RoEdAl `ao2`

This branch carries Homenichat-specific patches on top of upstream
`RoEdAl/asterisk-chan-quectel@ao2` to make `chan_quectel` UAC audio work
on modern Linux kernels + libasound versions (notably Raspberry Pi CM4 +
Ubuntu 22.04 / kernel 5.15 raspi / xhci_hcd / libasound 1.2.6).

Upstream `ao2` already brings substantial ALSA-layer improvements over
`master` (`snd_pcm_forward` to drain capture buffer drift, period_time
based hw_params, refined locking via AO2). It is the right base for any
fresh deployment.

Without the patches below, on the CM4/Ubuntu 22.04 reference stack, the
audio path stays silent or produces saccaded/distorted output even though
the EC25 modem itself transmits clean audio (validated by raw `arecord` /
`aplay` against the modem ALSA card during a `ATD` call without
chan_quectel).

## What this branch changes

### 1. `src/at_response.c` — EC25 CLCC fast-SVI fix (1 line)

Add `case CALL_STATE_ACTIVE:` to the CLCC index-adoption fallback in
`handle_clcc`. RoEdAl only adopts the modem's CLCC index when the call
is in DIALING/ALERTING. On the EC25, a fast-answer IVR (peer answers
inside the very first CLCC report) emits an ACTIVE state without going
through DIALING — the call would otherwise stay orphan, never reach
`AST_CONTROL_ANSWER`, leave the app stuck in early-media (DTMF KO,
duration 0) and lock the modem on hangup (`AT+QHUP` fails).

Originally applied on the BLIIOT box in May 2026 and validated in
production. The same patch is needed whenever an EC25 is used.

### 2. `src/chan_quectel.c` — `snd_pcm_link` disabled

`soundcard_init` no longer calls `snd_pcm_link(icard, ocard)`. On
libasound 1.2.6, the linked pair returns `-EPIPE` from
`snd_pcm_start` because the playback side has `start_threshold=2000`
which the group-start cannot honour without buffered audio. Without
linking, each stream starts on its own — capture explicitly via
`snd_pcm_start` at call activation (see below), playback implicitly via
`start_threshold` once Asterisk has written enough samples.

### 3. `src/chan_quectel.c` — `pvt->a_timer = ast_timer_open()` unconditional

Upstream only opens the audio timer inside the `multiparty` branch of
`pvt_on_create_1st_channel`. In single-party UAC (the common case),
`a_timer` stays NULL and `ast_channel_set_fd(channel, 1, ...)` is
skipped — Asterisk has only the ALSA capture pollfd (fd 0) as wake
source for the channel.

On kernel 5.15+ xhci_hcd snd_usb_audio, that pollfd does not signal
POLLIN while the stream is in PREPARED state. With no timer either,
the channel never gets `.read` called → stream never gets started →
zero audio. Open the timer unconditionally so we always have a 50 Hz
wake source.

### 4. `src/cpvt.c` — explicit `snd_pcm_start` at `CALL_STATE_ACTIVE`

Add a `snd_pcm_start(pvt->icard)` call right after `cpvt_call_activate`
in the `CALL_STATE_ACTIVE` branch of the state machine. This pushes the
capture stream from PREPARED to RUNNING on call answer, *before* the
first `.read` callback. Once RUNNING, the ALSA pollfd starts firing
POLLIN normally and the rest of the read path works as upstream
intended.

### 5. `src/channel.c` — no `channel_read_uac` on every timer tick

The original code logs `"Multiparty calls not supported in UAC mode"`
and returns silence on every timer tick. Upstream `ao2` didn't fix
this. We removed the warning and the dispatch — once the stream is
started at CALL_STATE_ACTIVE (see #4), the pollfd alone drives reads
at the correct rate. Calling `channel_read_uac` on every timer tick on
top of pollfd-driven reads would double the read rate and over-feed the
playback side.

### 6. `src/ptime-config.h.in` — `PTIME_BUFFER=400`, `PTIME_EXTRA=0`

Two tuning constants that turned out to matter on kernel 5.15 + xhci +
EC25 + libasound 1.2.6:

  - `PTIME_BUFFER = 400` (was 1000). The 1 s default buffer is far too
    big for a 8 kHz voice channel. It lets the host/device clock drift
    accumulate up to ~125 ms before `snd_pcm_forward` kicks in to drop
    a chunk — and each drop is audible as a saccade. 400 ms gives
    enough headroom over `start_threshold` (250 ms in
    `adjust_start_threshold`) while keeping the buffer small enough
    that drift never accumulates audibly.
  - `PTIME_EXTRA = 0` (was 10). The +10 ms made `period_time` 30 ms
    (240 frames) on the ALSA side while Asterisk wants 20 ms frames
    (160). The mismatch forced the read path to either under-read
    (pollfd fires less often than Asterisk reads frames) or
    accumulate in the capture buffer until `snd_pcm_forward` had to
    drop a chunk. Setting `PTIME_EXTRA=0` aligns ALSA's period with
    Asterisk's frame size — pollfd fires every 20 ms, exactly matching
    the read rate.

## Live validation

Tested on `homenibox@192.168.1.72` (Raspberry Pi CM4 + EC25-EUX
firmware A19, Ubuntu 22.04.5 LTS, kernel 5.15.0-1061-raspi):

| Test | Before | After |
|---|---|---|
| Echo() over LTE, 14 s call | 0 byte read / 0 byte written, both PCMs PREPARED | 1385 frames read / 1399 frames written, both PCMs RUNNING, 0 short frame |
| Playback(hello-world / demo-congrats / tt-monkeys) | not testable (Echo never produced any audio) | clear playback |
| Echo() listener feedback | silence / faint crepitations / saccaded | crisp echo with normal phone-call latency |

## Build

Identical to upstream. CMake-based:

```
cd asterisk-chan-quectel
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR=lib ..
make -j$(nproc)
cp src/chan_quectel.so /usr/lib/$(uname -m)-linux-gnu/asterisk/modules/
```

Used by `install-cm4.sh` in `homenichat-serv` which pins this branch.

## Compatibility

The patches are designed to be no-op on the platforms where upstream
already worked (BLIIOT BL340 + Ubuntu 20.04 + kernel 4.9-rt + libasound
1.2.2 + sunxi-ehci): the unconditional timer gives a redundant but
harmless second wake source, the explicit `snd_pcm_start` is idempotent
once the stream is RUNNING, removing `snd_pcm_link` only matters when
the start fails (which it doesn't on the legacy stack), and the
ptime-config defaults are within the range that legacy hardware
tolerates.

TTY-audio mode (`uac=no`) is completely untouched — none of these
patches are in code paths reached when UAC is disabled.

## See also

- Investigation log: see `homenichat-serv/RAPPORT-NUIT-2026-05-24.md`
- Operator notes: `homenichat-serv/scripts/install-cm4.sh` (pinned
  branch + comments explaining what to pull at install time)
