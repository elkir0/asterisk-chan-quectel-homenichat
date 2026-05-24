const assert = require('assert');
const fs = require('fs');
const path = require('path');

const channelSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'channel.c'), 'utf8');
const cpvtSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cpvt.c'), 'utf8');

function functionBody(source, name) {
  const marker = `${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);

  const brace = source.indexOf('{', start);
  assert.ok(brace >= 0, `missing ${name} body`);

  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(brace, i + 1);
      }
    }
  }

  throw new Error(`unterminated ${name} body`);
}

function xrunCase(body) {
  const match = body.match(/case SND_PCM_STATE_XRUN:\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(match, 'missing SND_PCM_STATE_XRUN case');
  return match[1];
}

function testPlaybackXrunOnlyRecoversPlaybackPcm() {
  const body = functionBody(channelSource, 'channel_write_uac');
  const xrun = xrunCase(body);

  assert.match(
    xrun,
    /snd_pcm_prepare\(pvt->ocard\)/,
    'playback XRUN recovery must prepare the playback PCM handle'
  );
  assert.doesNotMatch(
    xrun,
    /snd_pcm_prepare\(pvt->icard\)/,
    'playback XRUN recovery must not prepare the active capture PCM handle'
  );
}

function testCaptureXrunOnlyRecoversCapturePcm() {
  const body = functionBody(channelSource, 'channel_read_uac');
  const xrun = xrunCase(body);

  assert.match(
    xrun,
    /snd_pcm_prepare\(pvt->icard\)/,
    'capture XRUN recovery must prepare the capture PCM handle'
  );
  assert.doesNotMatch(
    xrun,
    /snd_pcm_prepare\(pvt->ocard\)/,
    'capture XRUN recovery must not prepare the playback PCM handle'
  );
}

function testCallAudioLifecycleResetsUacPcmHandles() {
  const resetBody = functionBody(cpvtSource, 'uac_reset_call_audio');

  assert.match(
    resetBody,
    /uac_reset_pcm_stream\(pvt,\s*pvt->ocard,\s*"PLAYBACK",\s*0\)/,
    'call audio reset must reset playback PCM independently'
  );
  assert.match(
    resetBody,
    /uac_reset_pcm_stream\(pvt,\s*pvt->icard,\s*"CAPTURE",\s*start_capture\)/,
    'call audio reset must reset capture PCM independently'
  );

  const streamResetBody = functionBody(cpvtSource, 'uac_reset_pcm_stream');
  assert.match(streamResetBody, /snd_pcm_drop\(pcm\)/, 'PCM reset must drop stale buffered audio');
  assert.match(streamResetBody, /snd_pcm_prepare\(pcm\)/, 'PCM reset must prepare the stream after dropping stale audio');
  assert.match(streamResetBody, /snd_pcm_start\(pcm\)/, 'capture reset must be able to restart capture after prepare');

  const disactivateBody = functionBody(cpvtSource, 'cpvt_call_disactivate');
  assert.match(
    disactivateBody,
    /uac_reset_call_audio\(pvt,\s*0\)/,
    'call release/disactivate must reset stale UAC buffers before the next call'
  );

  const changeStateBody = functionBody(cpvtSource, 'change_state');
  const activeCase = changeStateBody.match(/case CALL_STATE_ACTIVE:[\s\S]*?break;/);
  assert.ok(activeCase, 'missing CALL_STATE_ACTIVE state handler');
  assert.match(
    activeCase[0],
    /uac_reset_call_audio\(pvt,\s*1\)/,
    'call activation must reset UAC buffers and restart capture'
  );
}

testPlaybackXrunOnlyRecoversPlaybackPcm();
testCaptureXrunOnlyRecoversCapturePcm();
testCallAudioLifecycleResetsUacPcmHandles();

console.log('homenichat ALSA XRUN recovery tests passed');
