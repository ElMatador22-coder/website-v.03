// offscreen.js
// Media + STT host. This is the only surface that touches audio. It receives control
// messages from the service worker, runs dual-stream capture and per-channel STT, and
// reports interim + finalized transcript back up. It performs NO ingestion and NO engine
// work — it just produces finalized utterances.

import { Target, MsgType, Channel, msg, onMessage } from '../common/messaging.js';
import { createSttProvider } from '../stt/stt-adapter.js';
import { DualStreamCapture } from '../capture/dual-stream.js';
import { TranscriptBuffer } from '../pipeline/transcript-buffer.js';

const STT_KEY_STORAGE = 'salesogre.listener.sttKey';

let capture = null;
let buffer = null;
const providers = { [Channel.THEM]: null, [Channel.US]: null };

function send(type, payload) {
  chrome.runtime.sendMessage(msg(Target.SW, type, payload)).catch(() => {});
}

async function getApiKey() {
  const s = await chrome.storage.local.get(STT_KEY_STORAGE);
  return s[STT_KEY_STORAGE];
}

async function startCapture({ themStreamId, sttProvider, sampleRate, frameSize, maxSilenceMs }) {
  // Buffer turns STT results into finalized utterances and assigns a session-local seq.
  buffer = new TranscriptBuffer({
    maxSilenceMs,
    onFinal: (utterance) => {
      // Report the finalized utterance up to the SW, which builds the note object and
      // calls the one ingestion seam.
      send(MsgType.TRANSCRIPT_FINAL, utterance);
    },
  });

  // One STT provider per channel — this is our "them vs us" separation.
  for (const channel of [Channel.THEM, Channel.US]) {
    providers[channel] = createSttProvider(sttProvider, {
      channel,
      sampleRate,
      getApiKey,
      onResult: (result) => {
        const out = buffer.push({ channel, ...result });
        if (out.partial) {
          // interim text for live display only — never ingested
          send(MsgType.TRANSCRIPT_PARTIAL, out.partial);
        }
      },
      onError: (err) => send(MsgType.CAPTURE_ERROR, { channel, error: String(err?.message || err) }),
    });
    await providers[channel].start();
  }

  capture = new DualStreamCapture({
    sampleRate,
    frameSize,
    onFrame: (channel, frame) => {
      const p = providers[channel];
      if (p) p.pushAudio(frame);
    },
    onError: (channel, err) => send(MsgType.CAPTURE_ERROR, { channel, error: String(err?.message || err) }),
  });

  const startedChannels = await capture.start({ themStreamId, captureUs: true });
  send(MsgType.CAPTURE_STARTED, { channels: startedChannels });
}

async function stopCapture() {
  try {
    if (buffer) buffer.drain();           // flush any pending utterance -> final -> ingest
  } catch { /* ignore */ }
  try {
    if (capture) await capture.stop();
  } catch { /* ignore */ }
  for (const channel of [Channel.THEM, Channel.US]) {
    try { if (providers[channel]) await providers[channel].stop(); } catch { /* ignore */ }
    providers[channel] = null;
  }
  if (buffer) { buffer.dispose(); buffer = null; }
  capture = null;
  send(MsgType.CAPTURE_STOPPED, {});
}

onMessage(Target.OFFSCREEN, async (message) => {
  switch (message.type) {
    case MsgType.OFFSCREEN_START_CAPTURE:
      try {
        await startCapture(message.payload);
      } catch (err) {
        send(MsgType.CAPTURE_ERROR, { fatal: true, error: String(err?.message || err) });
      }
      return { ok: true };
    case MsgType.OFFSCREEN_STOP_CAPTURE:
      await stopCapture();
      return { ok: true };
    default:
      return undefined;
  }
});
