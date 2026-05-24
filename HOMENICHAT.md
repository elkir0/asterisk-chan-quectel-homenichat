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
audio path stays silent or produces slowed, bursty, saccaded output even
though the EC25 modem itself transmits clean audio (validated by raw
`arecord` / `aplay` against the modem ALSA card during a `ATD` call
without chan_quectel).

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

### 5. `src/channel.c` — UAC timer is a wake source, not an audio source

The original code logs `"Multiparty calls not supported in UAC mode"`
and returns silence on every timer tick. Upstream `ao2` didn't fix
this. We removed the warning and the dispatch — once the stream is
started at CALL_STATE_ACTIVE (see #4), the pollfd alone drives reads
at the correct rate. Calling `channel_read_uac` on every timer tick on
top of pollfd-driven reads would double the read rate and over-feed the
playback side.

The final CM4 production fix is stricter: when Asterisk wakes the
channel on the auxiliary timer fd (`fdno == 1`) in UAC mode, the code
acks the timer and returns `ast_null_frame`. It must not fall through
to the common silence-frame return path. Falling through injected one
extra 20 ms silence frame between real 20 ms ALSA capture frames. The
scientific symptom was a 20 s CDR producing a 40.000 s WAV and iPhone
audio that sounded half-speed and bursty.

### 6. `src/channel.c` — balanced UAC capture backlog threshold

The UAC capture backlog threshold is set to `(3 * frames) / 2`. This
keeps ALSA capture close to the wall clock on the CM4/xhci stack while
still allowing a small amount of jitter. The validated production build
uses this threshold.

### 7. `src/ptime-config.h.in` — `PTIME_BUFFER=400`, `PTIME_EXTRA=0`

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

## Required runtime EC25 settings

The chan_quectel patches above fix the host/ALSA side.  The EC25 modem
itself also needs three NV-saved AT settings tuned for this stack — these
do not belong in the chan_quectel `.so` (they are per-modem firmware
state) but they are essential for the audio to actually be audible and
to ride on LTE instead of falling back to 3G:

| AT setting | Value | Why |
|---|---|---|
| `AT+QRXGAIN` | **16384** (2× unity) | Default 8192 gives chan_quectel a capture signal ~24 dB below nominal — `arecord` direct on the same hw card gets mean abs ~210, chan_quectel sees ~13.  Bumping RX 2× brings capture to parity with `arecord`.  Empirically measured via MixMonitor reads. |
| `AT+QMIC` | **4096,4096** (0.5× unity) | Compensates for the 2× RX boost on the Echo round-trip: without it, the audio sent back over GSM saturates and clips. |
| `AT+QPCMV` | **1,2** (force-cycle =0 then =1,2 on each preflight) | Required for USB Audio Class.  The cycle is needed because after a USB unplug/replug or `AT+CFUN=1,1`, the EC25 reports QPCMV=1,2 while audio does not actually flow.  Toggling =0 then =1,2 re-initializes the USB Audio Class endpoints.  Reference: IchthysMaranatha/asterisk-chan-quectel discussion #2 (abdofallah, 2025-05-02). |
| `AT+QMBNCFG="AutoSel"` | **1** | Without it the modem stays on no carrier profile and IMS never moves from `"ims",1,0` (enabled-not-registered) to `"ims",1,1` (registered).  With it the `ROW_Generic_3GPP` profile is picked automatically and IMS SIP REGISTER succeeds. |
| `AT+CGDCONT=5,"IPV4V6","ims"` | (context 5) | Defines the IMS APN PDP context.  Required for VoLTE call routing; without it, calls fall back to CSFB (3G WCDMA, Mode 4 in `quectel show devices`) instead of staying on LTE (Mode 8). |
| `AT+QCFG="ims"` | **1** (first param) | Force IMS on.  Combined with `AutoSel=1` + the IMS APN PDP context, this yields `+QCFG: "ims",1,1` after a modem reset and a real VoLTE call (LTE simultaneous voice+data). |

All these are applied automatically by
`homenichat-serv/scripts/bliiot/ec25-volte-preflight.sh` (commit
`208a63f`) via the `homenichat-ec25-volte-preflight.service` systemd
unit at boot.  A one-shot `AT&W` + `AT+CFUN=1,1` is required after a
fresh deployment to persist the values and let MBN AutoSel pick the
profile.

## Live validation

Tested on `homenibox@192.168.1.72` (Raspberry Pi CM4 + EC25-EUX
firmware A19, Ubuntu 22.04.5 LTS, kernel 5.15.0-1061-raspi):

| Test | Before | After |
|---|---|---|
| Echo() over LTE, 14 s call | 0 byte read / 0 byte written, both PCMs PREPARED | 1385 frames read / 1399 frames written, both PCMs RUNNING, 0 short frame |
| Record() to GSM voicemail, 20 s CDR | WAV duration 40.000 s (extra timer silence frames) | WAV duration 20.000 s |
| Homenichat iPhone app -> GSM voicemail | slowed + bursty audio | clean audio, validated by human listening test |
| Playback(hello-world / demo-congrats / tt-monkeys) | not testable (Echo never produced any audio) | clear playback |
| Echo() listener feedback | silence / faint crepitations / saccaded / saturated | crisp clean echo at normal phone-call level |
| Capture amplitude (read.wav from MixMonitor) | mean abs 13, peak ±1435 | mean abs 202, peak ±11024 |
| Network mode during call | `Mode 4 = WCDMA` (CSFB 3G voice) | `Mode 8 = LTE` (VoLTE) |
| Simultaneous data during voice call | n/a — CSFB drops LTE data | 25/25 pings to 8.8.8.8 received, 0 % loss, 55–90 ms latency throughout |
| IMS registration state | `+QCFG: "ims",1,0` (enabled, not registered) | `+QCFG: "ims",1,1` (registered) |

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
