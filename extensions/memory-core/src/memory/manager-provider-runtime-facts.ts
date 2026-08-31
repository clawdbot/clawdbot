// Memory Core reads optional provider runtime diagnostics without widening the provider contract.
import type { EmbeddingProvider } from "./embeddings.js";

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

export function getLocalEmbeddingRuntimeFacts(provider: EmbeddingProvider | null): unknown {
  if (!provider) {
    return undefined;
  }
  const getRuntimeFacts = Reflect.get(provider, LOCAL_EMBEDDING_RUNTIME_FACTS);
  return typeof getRuntimeFacts === "function" ? getRuntimeFacts() : undefined;
}
