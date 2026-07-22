// mock-provider.js
// Zero-dependency, no-network STT provider. It ignores real audio content and instead
// emits a scripted stream of partial->final results so the entire capture -> STT ->
// note -> ingestion -> side panel pipeline runs end-to-end offline. This is the default
// provider (see config) so the extension is loadable and demoable without any vendor key.
//
// It fabricates buyer-side ("them") vs rep-side ("us") lines appropriate to the channel,
// and occasionally attaches a speaker label on "them" to exercise the pass-through path.

const THEM_LINES = [
  "So walk me through how the rollout actually works.",
  "What's the rollback plan if this doesn't land with the team?",
  "I'll need to loop in security before we can commit to anything.",
  "Honestly the budget for this quarter is basically spoken for.",
  "When we roll this out, how fast do reps see value?",
  "Send me the details and I'll take a look when I get a chance.",
];

const US_LINES = [
  "Great question — let me show you the staged approval flow.",
  "We can de-risk that with a phased pilot on one team first.",
  "Who else would need to be in the room for a decision like this?",
  "What would need to be true for this to be an easy yes?",
];

export class MockProvider {
  /**
   * @param {object} opts see createSttProvider
   */
  constructor({ channel, onResult, onError }) {
    this.channel = channel;
    this.onResult = onResult;
    this.onError = onError || (() => {});
    this._timer = null;
    this._i = 0;
    this._running = false;
    this._lines = channel === 'us' ? US_LINES : THEM_LINES;
  }

  async start() {
    this._running = true;
    // stagger channels so "them" and "us" don't fire in perfect lockstep
    const initialDelay = this.channel === 'us' ? 3500 : 1500;
    this._scheduleNext(initialDelay);
  }

  // Real audio is discarded by the mock. Kept to satisfy the interface.
  pushAudio(_chunk) { /* no-op */ }

  _scheduleNext(delay) {
    if (!this._running) return;
    this._timer = setTimeout(() => this._emitUtterance(), delay);
  }

  _emitUtterance() {
    if (!this._running) return;
    const text = this._lines[this._i % this._lines.length];
    this._i += 1;
    // emit a couple of partials, then a final, to mimic streaming behavior
    const words = text.split(' ');
    const mid = Math.max(1, Math.floor(words.length / 2));
    const label = this.channel === 'them' && this._i % 2 === 0 ? `Speaker ${this._i % 3}` : null;

    this.onResult({ text: words.slice(0, mid).join(' '), isFinal: false, speakerLabel: label, confidence: 0.7 });
    setTimeout(() => {
      if (!this._running) return;
      this.onResult({ text, isFinal: false, speakerLabel: label, confidence: 0.85 });
    }, 400);
    setTimeout(() => {
      if (!this._running) return;
      this.onResult({ text, isFinal: true, speakerLabel: label, confidence: 0.93 });
      // next utterance after a natural gap
      this._scheduleNext(4000 + Math.floor((this._i * 137) % 3000));
    }, 900);
  }

  async stop() {
    this._running = false;
    clearTimeout(this._timer);
    this._timer = null;
  }
}
