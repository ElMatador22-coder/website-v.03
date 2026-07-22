// deepgram-provider.js
// Example of a REAL streaming STT provider behind the same interface as the mock. This
// is a reference implementation: it shows the shape (open WebSocket, stream 16-bit PCM,
// parse partial/final results, pass through diarization labels) without pretending to be
// production-hardened. Swapping to any other vendor means writing one file like this and
// registering it in stt-adapter.js — nothing downstream changes.
//
// The API key is fetched lazily via opts.getApiKey (which should call the backend for a
// short-lived token) so no vendor secret is ever committed or shipped in the bundle.

const DG_STREAMING_URL =
  'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&interim_results=true&diarize=true&punctuate=true';

export class DeepgramProvider {
  constructor({ channel, sampleRate = 16000, onResult, onError, getApiKey }) {
    this.channel = channel;
    this.sampleRate = sampleRate;
    this.onResult = onResult;
    this.onError = onError || (() => {});
    this.getApiKey = getApiKey;
    this._ws = null;
    this._open = false;
    this._queue = [];
  }

  async start() {
    const key = this.getApiKey ? await this.getApiKey() : undefined;
    if (!key) throw new Error('DeepgramProvider: no API key available (getApiKey returned empty)');

    // Deepgram accepts the token via the Sec-WebSocket-Protocol header trick.
    this._ws = new WebSocket(DG_STREAMING_URL, ['token', key]);
    this._ws.binaryType = 'arraybuffer';

    this._ws.onopen = () => {
      this._open = true;
      // flush anything buffered before the socket opened
      for (const chunk of this._queue) this._ws.send(chunk);
      this._queue = [];
    };

    this._ws.onmessage = (evt) => this._onMessage(evt);
    this._ws.onerror = (e) => this.onError(new Error(`Deepgram socket error: ${e?.message || 'unknown'}`));
    this._ws.onclose = () => { this._open = false; };
  }

  _onMessage(evt) {
    let data;
    try { data = JSON.parse(evt.data); } catch { return; }
    const alt = data?.channel?.alternatives?.[0];
    if (!alt || !alt.transcript) return;

    // Diarization pass-through: Deepgram tags each word with a speaker index. We surface
    // the first word's speaker as the utterance label. We do NOT try to be cleverer than
    // the provider — "them vs us" already comes from the separate stream.
    let speakerLabel = null;
    const spk = alt.words?.[0]?.speaker;
    if (spk !== undefined && spk !== null) speakerLabel = `Speaker ${spk}`;

    this.onResult({
      text: alt.transcript,
      isFinal: Boolean(data.is_final),
      speakerLabel,
      confidence: typeof alt.confidence === 'number' ? alt.confidence : null,
    });
  }

  /**
   * @param {Float32Array|ArrayBuffer} chunk - mono audio at this.sampleRate
   */
  pushAudio(chunk) {
    const pcm16 = chunk instanceof Float32Array ? floatTo16BitPCM(chunk) : chunk;
    if (this._open && this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(pcm16);
    } else {
      this._queue.push(pcm16);
    }
  }

  async stop() {
    try {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        // Deepgram flush/close message
        this._ws.send(JSON.stringify({ type: 'CloseStream' }));
        this._ws.close();
      }
    } finally {
      this._ws = null;
      this._open = false;
      this._queue = [];
    }
  }
}

/**
 * Convert Float32 [-1,1] samples to little-endian 16-bit PCM.
 * @param {Float32Array} input
 * @returns {ArrayBuffer}
 */
function floatTo16BitPCM(input) {
  const out = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    out.setInt16(i * 2, s, true);
  }
  return out.buffer;
}
