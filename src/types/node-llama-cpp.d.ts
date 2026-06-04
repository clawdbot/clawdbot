/** Minimal ambient types for node-llama-cpp embedding support. */
declare module "node-llama-cpp" {
  /** Log levels used when initializing llama.cpp. */
  export enum LlamaLogLevel {
    error = 0,
  }

  /** Embedding vector returned by llama.cpp. */
  export type LlamaEmbedding = { vector: Float32Array | number[] };

  /** Embedding context subset used for local memory/vector features. */
  export type LlamaEmbeddingContext = {
    getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
    dispose?: () => Promise<void> | void;
  };

  /** Loaded model subset used to create embedding contexts. */
  export type LlamaModel = {
    createEmbeddingContext: (options?: {
      contextSize?: number | "auto";
      createSignal?: AbortSignal;
    }) => Promise<LlamaEmbeddingContext>;
    dispose?: () => Promise<void> | void;
  };

  /** Options accepted by model-file resolution. */
  export type ResolveModelFileOptions = {
    directory?: string;
    signal?: AbortSignal;
  };

  /** Top-level llama.cpp runtime subset used by OpenClaw. */
  export type Llama = {
    loadModel: (params: { modelPath: string; loadSignal?: AbortSignal }) => Promise<LlamaModel>;
    dispose?: () => Promise<void> | void;
  };

  /** Initialize the llama.cpp runtime. */
  export function getLlama(params: { logLevel: LlamaLogLevel }): Promise<Llama>;
  /** Resolve a model file path from a directory or options object. */
  export function resolveModelFile(
    modelPath: string,
    optionsOrDirectory?: string | ResolveModelFileOptions,
  ): Promise<string>;
}
