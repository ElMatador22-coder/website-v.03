// stt-adapter.js
// Provider-agnostic streaming speech-to-text. Downstream code (transcript buffer, note
// builder, ingestion) knows nothing about which vendor produced the text — swap the
// provider here and nothing else changes.
//
// THE INTERFACE every provider implements:
//
//   interface SttProvider {
//     start(): Promise<void>            // open the streaming session
//     pushAudio(chunk: Float32Array | ArrayBuffer): void  // feed one audio frame
//     stop(): Promise<void>             // flush + close
//   }
//
// and it emits results via the onResult callback passed at construction:
//
//   onResult({
//     text: string,
//     isFinal: boolean,
//     speakerLabel: string | null,   // passed through iff the provider returns diarization
//     confidence: number | null,
//   })
//
// One provider instance handles ONE audio channel ("them" or "us"). The offscreen doc
// creates two instances. This is why we get "them vs us" separation for free and never
// attempt in-house diarization in v1.

import { MockProvider } from './providers/mock-provider.js';
import { DeepgramProvider } from './providers/deepgram-provider.js';

/**
 * Registry of available providers. Add a vendor by dropping a module in providers/ and
 * registering it here — no downstream changes.
 * @type {Record<string, new (opts:object)=>object>}
 */
const REGISTRY = {
  mock: MockProvider,
  deepgram: DeepgramProvider,
};

/**
 * Construct a streaming STT provider for one channel.
 * @param {string} id - provider id (config.sttProvider)
 * @param {object} opts
 * @param {string} opts.channel - which channel this instance transcribes (for labels/logs)
 * @param {number} opts.sampleRate
 * @param {(result:object)=>void} opts.onResult
 * @param {(err:Error)=>void} [opts.onError]
 * @param {() => Promise<string|undefined>} [opts.getApiKey] - lazy key fetch for real providers
 * @returns {object} an SttProvider instance
 */
export function createSttProvider(id, opts) {
  const Provider = REGISTRY[id];
  if (!Provider) {
    throw new Error(`Unknown STT provider "${id}". Registered: ${Object.keys(REGISTRY).join(', ')}`);
  }
  return new Provider(opts);
}

export function listSttProviders() {
  return Object.keys(REGISTRY);
}
