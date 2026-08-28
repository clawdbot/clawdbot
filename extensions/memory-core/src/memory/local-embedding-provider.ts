export const LOCAL_MEMORY_EMBEDDING_PROVIDER_ID = "local";
export const LLAMA_CPP_PROVIDER_INSTALL_COMMAND =
  "openclaw plugins install @openclaw/llama-cpp-provider";

export const MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE = [
  "Unknown memory embedding provider: local.",
  "Local GGUF embeddings are provided by the official llama.cpp provider plugin.",
  `Install it with: ${LLAMA_CPP_PROVIDER_INSTALL_COMMAND}`,
  "Then restart OpenClaw and retry: openclaw memory status --deep",
].join("\n");

export function createMissingLocalMemoryEmbeddingProviderError(): Error {
  return new Error(MISSING_LOCAL_MEMORY_EMBEDDING_PROVIDER_MESSAGE);
}
