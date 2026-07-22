// dual-stream.js
// Captures the two audio channels SEPARATELY and emits framed PCM per channel.
//
//   "them" = remote participants  -> chrome.tabCapture (streamId minted by the SW)
//   "us"   = the rep              -> getUserMedia microphone
//
// Capturing them as two independent streams is our speaker separation for v1. We do NOT
// attempt full diarization; each stream is simply a channel. Sub-speakers within "them"
// are only distinguished if the STT provider returns labels (handled downstream).
//
// Runs INSIDE the offscreen document — MV3 service workers cannot hold MediaStreams.
//
// tabCapture gotcha handled below: a tab-captured stream, by default, silences the tab
// for the user. We re-route the captured audio back to the speakers so the rep still
// hears the call while we transcribe it.

import { Channel } from '../common/messaging.js';

export class DualStreamCapture {
  /**
   * @param {object} opts
   * @param {number} opts.sampleRate - target rate for the AudioContext (STT input rate)
   * @param {number} opts.frameSize - samples per emitted frame
   * @param {(channel:string, frame:Float32Array)=>void} opts.onFrame
   * @param {(channel:string, err:Error)=>void} [opts.onError]
   */
  constructor({ sampleRate, frameSize, onFrame, onError }) {
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
    this.onFrame = onFrame;
    this.onError = onError || (() => {});
    this._nodes = { [Channel.THEM]: null, [Channel.US]: null };
  }

  /**
   * @param {object} args
   * @param {string} args.themStreamId - tabCapture media stream id from the service worker
   * @param {boolean} [args.captureUs=true] - also capture the rep mic
   */
  async start({ themStreamId, captureUs = true }) {
    const started = [];
    // "them" — the tab. If no streamId (e.g. no active tab), we skip it rather than fail
    // the whole session; a mic-only session is still useful.
    if (themStreamId) {
      const themStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: themStreamId,
          },
        },
      });
      await this._wireChannel(Channel.THEM, themStream, { echoToSpeakers: true });
      started.push(Channel.THEM);
    }

    // "us" — the rep microphone.
    if (captureUs) {
      try {
        const usStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        await this._wireChannel(Channel.US, usStream, { echoToSpeakers: false });
        started.push(Channel.US);
      } catch (err) {
        // Mic denied is non-fatal — we can still transcribe "them".
        this.onError(Channel.US, err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (started.length === 0) {
      throw new Error('No audio channels could be captured (no tab stream and no microphone).');
    }
    return started;
  }

  async _wireChannel(channel, stream, { echoToSpeakers }) {
    const ctx = new AudioContext({ sampleRate: this.sampleRate });
    // The worklet module path is resolved through the extension origin.
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('src/offscreen/pcm-worklet.js'));

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'pcm-worklet', {
      processorOptions: { frameSize: this.frameSize },
    });
    worklet.port.onmessage = (evt) => this.onFrame(channel, evt.data);

    source.connect(worklet);

    // tabCapture mutes the tab for the user unless we route it back to the output.
    if (echoToSpeakers) source.connect(ctx.destination);

    this._nodes[channel] = { ctx, stream, source, worklet };
  }

  async stop() {
    for (const channel of Object.keys(this._nodes)) {
      const n = this._nodes[channel];
      if (!n) continue;
      try {
        n.worklet.port.onmessage = null;
        n.worklet.disconnect();
        n.source.disconnect();
        n.stream.getTracks().forEach((t) => t.stop());
        await n.ctx.close();
      } catch { /* best-effort teardown */ }
      this._nodes[channel] = null;
    }
  }
}
