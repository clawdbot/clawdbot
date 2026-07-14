// Leaf contract shared by streaming.ts and streaming-flat-key-deprecation.ts;
// living here keeps the compat module off streaming.ts and out of madge cycles.
// The flat fields die with the fallback window after the next release train.
export type StreamingCompatEntry = {
  /**
   * Canonical nested streaming config. External SDK plugin configs may still
   * carry a scalar mode string or boolean here; bundled schemas reject those.
   */
  streaming?: unknown;
  chunkMode?: unknown;
  blockStreaming?: unknown;
  blockStreamingCoalesce?: unknown;
  draftChunk?: unknown;
};
