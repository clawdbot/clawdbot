// Memory Host SDK module implements embeddings worker child behavior.
import { createLocalEmbeddingProviderInProcess } from "./embeddings.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";
import { getLocalEmbeddingRuntimeFacts } from "./local-embedding-runtime-facts.js";

// Child process entrypoint for local embedding work.

/** Request payloads accepted from the parent worker client. */
type LocalEmbeddingWorkerRequest =
  | {
      id: number;
      type: "initialize";
      options: EmbeddingProviderOptions;
    }
  | {
      id: number;
      type: "embedQuery";
      options: EmbeddingProviderOptions;
      text: string;
    }
  | {
      id: number;
      type: "embedBatch";
      options: EmbeddingProviderOptions;
      texts: string[];
    }
  | {
      id: number;
      type: "close";
    };

/** Serialized error shape returned over JSON IPC. */
type LocalEmbeddingWorkerSerializedError = {
  message: string;
  code?: string;
};

let provider: EmbeddingProvider | null = null;
let providerOptionsKey: string | null = null;
let requestQueue: Promise<void> = Promise.resolve();

/** Send one JSON IPC message when the child still has an IPC channel. */
function send(message: unknown): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

/** Reuse the current provider while options are unchanged, otherwise rebuild it. */
async function getProvider(options: EmbeddingProviderOptions): Promise<EmbeddingProvider> {
  const key = JSON.stringify(options);
  if (provider && providerOptionsKey === key) {
    return provider;
  }
  await provider?.close?.();
  provider = await createLocalEmbeddingProviderInProcess(options);
  providerOptionsKey = key;
  return provider;
}

/** Close and forget the active in-process provider. */
async function closeProvider(): Promise<void> {
  const current = provider;
  provider = null;
  providerOptionsKey = null;
  await current?.close?.();
}

/** Preserve error message and code across JSON IPC. */
function serializeError(err: unknown): LocalEmbeddingWorkerSerializedError {
  if (!(err instanceof Error)) {
    return { message: String(err) };
  }
  const code = (err as Error & { code?: unknown }).code;
  return {
    message: err.message,
    ...(typeof code === "string" ? { code } : {}),
  };
}

/** Handle one parent request after queue serialization. */
async function handleRequest(request: LocalEmbeddingWorkerRequest): Promise<void> {
  if (request.type === "close") {
    await closeProvider();
    send({ id: request.id, ok: true });
    return;
  }

  const currentProvider = await getProvider(request.options);
  if (request.type === "initialize") {
    send({
      id: request.id,
      ok: true,
      runtimeFacts: getLocalEmbeddingRuntimeFacts(currentProvider),
    });
    return;
  }
  if (request.type === "embedQuery") {
    const value = await currentProvider.embedQuery(request.text);
    send({
      id: request.id,
      ok: true,
      value,
      runtimeFacts: getLocalEmbeddingRuntimeFacts(currentProvider),
    });
    return;
  }

  const value = await currentProvider.embedBatch(request.texts);
  send({
    id: request.id,
    ok: true,
    value,
    runtimeFacts: getLocalEmbeddingRuntimeFacts(currentProvider),
  });
}

// Requests are serialized so node-llama-cpp context state is not used concurrently.
process.on("message", (message) => {
  const request = message as LocalEmbeddingWorkerRequest;
  requestQueue = requestQueue.then(async () => {
    try {
      await handleRequest(request);
    } catch (err) {
      send({
        id: request.id,
        ok: false,
        error: serializeError(err),
        runtimeFacts: getLocalEmbeddingRuntimeFacts(provider),
      });
    }
  });
});

// Parent disconnect means the worker is orphaned; close provider resources before exiting.
process.once("disconnect", () => {
  void closeProvider().finally(() => {
    process.exit(0);
  });
});
