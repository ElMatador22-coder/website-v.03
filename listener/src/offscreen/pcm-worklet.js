// pcm-worklet.js
// AudioWorkletProcessor that batches raw mono Float32 samples into fixed-size frames and
// ships them to the main thread. Runs on the audio render thread, so it never blocks the
// UI or the service worker. Loaded via audioWorklet.addModule() — this file is NOT an ES
// module; it uses the AudioWorklet global scope.
//
// The AudioContext is constructed at the STT target sample rate (e.g. 16 kHz), so the
// browser has already resampled by the time samples reach here. We only reframe.

class PcmWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = options?.processorOptions?.frameSize || 4000; // samples per posted frame
    this._frameSize = target;
    this._buf = new Float32Array(target);
    this._filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0]; // mono (first channel)
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this._buf[this._filled++] = ch[i];
      if (this._filled === this._frameSize) {
        // transfer a copy so the buffer can be reused immediately
        const frame = this._buf.slice(0, this._frameSize);
        this.port.postMessage(frame, [frame.buffer]);
        this._filled = 0;
      }
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
