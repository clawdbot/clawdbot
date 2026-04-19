export type LlamaEmbedding = {
  vector: Float32Array | number[];
};

export type LlamaEmbeddingContext = {
  getEmbeddingFor: (text: string) => Promise<LlamaEmbedding>;
};

export type LlamaModel = {
  createEmbeddingContext: () => Promise<LlamaEmbeddingContext>;
};

export type Llama = {
  loadModel: (params: { modelPath: string }) => Promise<LlamaModel>;
};

export type NodeLlamaCppModule = {
  LlamaLogLevel: {
    error: number;
  };
  getLlama: (params: { logLevel: number }) => Promise<Llama>;
  resolveModelFile: (modelPath: string, cacheDir?: string) => Promise<string>;
};

const NODE_LLAMA_CPP_MODULE = "node-llama-cpp";

export async function importNodeLlamaCpp() {
  return import(NODE_LLAMA_CPP_MODULE) as Promise<NodeLlamaCppModule>;
}
