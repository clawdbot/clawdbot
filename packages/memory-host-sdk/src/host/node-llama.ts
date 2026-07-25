// Minimal node-llama-cpp type facade used by the local embedding provider.

/** Embedding vector returned by node-llama-cpp. */
type LlamaEmbedding = {
  vector: Float32Array | number[];
};

/** Embedding context created from a loaded llama model. */
export type LlamaEmbeddingContext = {
  getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
  dispose?: () => Promise<void> | void;
};

/** Loaded llama model capable of creating embedding contexts. */
export type LlamaModel = {
  fileInsights: {
    totalLayers: number;
  };
  gpuLayers: number;
  createEmbeddingContext: (options?: {
    contextSize?: number | "auto";
    createSignal?: AbortSignal;
  }) => Promise<LlamaEmbeddingContext>;
  dispose?: () => Promise<void> | void;
};

/** Options accepted by node-llama-cpp model file resolution. */
type ResolveModelFileOptions = {
  directory?: string;
  signal?: AbortSignal;
};

/** Root llama runtime object exposed by node-llama-cpp. */
export type Llama = {
  gpu: "metal" | "cuda" | "vulkan" | false;
  buildType: "localBuild" | "prebuilt";
  supportsGpuOffloading: boolean;
  getGpuDeviceNames: () => Promise<string[]>;
  getVramState: () => Promise<{
    total: number;
    used: number;
    free: number;
    unifiedSize: number;
  }>;
  loadModel: (params: {
    modelPath: string;
    loadSignal?: AbortSignal;
    gpuLayers?:
      | "auto"
      | "max"
      | number
      | {
          min?: number;
          max?: number;
          fitContext?: {
            contextSize?: number;
            embeddingContext?: boolean;
          };
        };
  }) => Promise<LlamaModel>;
  dispose?: () => Promise<void> | void;
};

/** Imported node-llama-cpp module shape used by local embeddings. */
type NodeLlamaCppModule = {
  LlamaLogLevel: {
    error: number;
  };
  getLlama: (params: { logLevel: number }) => Promise<Llama>;
  resolveModelFile: (
    modelPath: string,
    optionsOrDirectory?: string | ResolveModelFileOptions,
  ) => Promise<string>;
};

const NODE_LLAMA_CPP_MODULE = "node-llama-cpp";

/** Dynamically import node-llama-cpp so the optional dependency is loaded only when needed. */
export async function importNodeLlamaCpp(moduleSpecifier = NODE_LLAMA_CPP_MODULE) {
  return import(moduleSpecifier) as Promise<NodeLlamaCppModule>;
}
