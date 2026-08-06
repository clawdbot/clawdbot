export type LocalEmbeddingRuntimeFacts = {
  engine: "llama.cpp";
  state: "ready" | "failed";
  backend?: "metal" | "cuda" | "vulkan" | "cpu";
  buildType?: "localBuild" | "prebuilt";
  deviceNames?: string[];
  memory?: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    unifiedBytes: number;
    observedAtMs: number;
  };
  offload?: {
    supported: boolean;
    offloadedLayers?: number;
    totalLayers?: number;
  };
  context?: {
    requestedSize: number | "auto";
  };
  loadError?: string;
};

const LOCAL_EMBEDDING_RUNTIME_FACTS = Symbol.for("openclaw.localEmbeddingRuntimeFacts");

export function attachLocalEmbeddingRuntimeFacts(
  target: object,
  getFacts: () => LocalEmbeddingRuntimeFacts | undefined,
): void {
  Object.defineProperty(target, LOCAL_EMBEDDING_RUNTIME_FACTS, {
    configurable: false,
    enumerable: false,
    value: getFacts,
    writable: false,
  });
}

export function getLocalEmbeddingRuntimeFacts(
  target: object | null | undefined,
): LocalEmbeddingRuntimeFacts | undefined {
  if (!target) {
    return undefined;
  }
  const getFacts = Reflect.get(target, LOCAL_EMBEDDING_RUNTIME_FACTS);
  return typeof getFacts === "function"
    ? (getFacts as () => LocalEmbeddingRuntimeFacts | undefined)()
    : undefined;
}
