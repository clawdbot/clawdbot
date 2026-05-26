import { createLocalEmbeddingProviderInProcess } from "./embeddings.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.types.js";

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

type LocalEmbeddingWorkerSerializedError = {
  message: string;
  code?: string;
};

let provider: EmbeddingProvider | null = null;
let providerOptionsKey: string | null = null;
let requestQueue: Promise<void> = Promise.resolve();

function send(message: unknown): void {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

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

async function closeProvider(): Promise<void> {
  const current = provider;
  provider = null;
  providerOptionsKey = null;
  await current?.close?.();
}

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

async function handleRequest(request: LocalEmbeddingWorkerRequest): Promise<void> {
  if (request.type === "close") {
    await closeProvider();
    send({ id: request.id, ok: true });
    return;
  }

  const currentProvider = await getProvider(request.options);
  if (request.type === "initialize") {
    send({ id: request.id, ok: true });
    return;
  }
  if (request.type === "embedQuery") {
    const value = await currentProvider.embedQuery(request.text);
    send({ id: request.id, ok: true, value });
    return;
  }

  const value = await currentProvider.embedBatch(request.texts);
  send({ id: request.id, ok: true, value });
}

process.on("message", (message) => {
  const request = message as LocalEmbeddingWorkerRequest;
  requestQueue = requestQueue.then(async () => {
    try {
      await handleRequest(request);
    } catch (err) {
      send({ id: request.id, ok: false, error: serializeError(err) });
    }
  });
});

process.once("disconnect", () => {
  void closeProvider().finally(() => {
    process.exit(0);
  });
});
