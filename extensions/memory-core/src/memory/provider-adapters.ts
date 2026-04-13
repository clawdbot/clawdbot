import fsSync from "node:fs";
import {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  OPENAI_BATCH_ENDPOINT,
  buildGeminiEmbeddingRequest,
  createGeminiEmbeddingProvider,
  createLmstudioEmbeddingProvider,
  createLocalEmbeddingProvider,
  createMistralEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  createVoyageEmbeddingProvider,
  hasNonTextEmbeddingParts,
  listRegisteredMemoryEmbeddingProviderAdapters,
  runGeminiEmbeddingBatches,
  runOpenAiEmbeddingBatches,
  runVoyageEmbeddingBatches,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { getProviderEnvVars } from "openclaw/plugin-sdk/provider-env-vars";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { formatErrorMessage } from "../dreaming-shared.js";
import { filterUnregisteredMemoryEmbeddingProviderAdapters } from "./provider-adapter-registration.js";

export type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
};

function isMissingApiKeyError(err: unknown): boolean {
  return formatErrorMessage(err).includes("No API key found for provider");
}

function sanitizeHeaders(
  headers: Record<string, string>,
  excludedHeaderNames: string[],
): Array<[string, string]> {
  const excluded = new Set(
    excludedHeaderNames.map((name) => normalizeLowercaseStringOrEmpty(name)),
  );
  return Object.entries(headers)
    .filter(([key]) => !excluded.has(normalizeLowercaseStringOrEmpty(key)))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, value]);
}

function mapBatchEmbeddingsByIndex(byCustomId: Map<string, number[]>, count: number): number[][] {
  const embeddings: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    embeddings.push(byCustomId.get(String(index)) ?? []);
  }
  return embeddings;
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && err.message.includes("node-llama-cpp");
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatErrorMessage(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 24 (recommended for installs/updates; Node 22 LTS, currently 22.14+, remains supported)",
    missing
      ? "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest"
      : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    ...["openai", "gemini", "voyage", "mistral"].map(
      (provider) => `Or set agents.defaults.memorySearch.provider = "${provider}" (remote).`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

function canAutoSelectLocal(modelPath?: string): boolean {
  const trimmed = modelPath?.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(hf:|https?:)/i.test(trimmed)) {
    return false;
  }
  const resolved = resolveUserPath(trimmed);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function supportsGeminiMultimodalEmbeddings(model: string): boolean {
  const normalized = model
    .trim()
    .replace(/^models\//, "")
    .replace(/^(gemini|google)\//, "");
  return normalized === "gemini-embedding-2-preview";
}

function resolveMemoryEmbeddingAuthProviderId(providerId: string): string {
  return providerId === "gemini" ? "google" : providerId;
}

const openAiAdapter: MemoryEmbeddingProviderAdapter = {
  id: "openai",
  defaultModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
  transport: "remote",
  autoSelectPriority: 20,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createOpenAiEmbeddingProvider({
      ...options,
      provider: "openai",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "openai",
        cacheKeyData: {
          provider: "openai",
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeHeaders(client.headers, ["authorization"]),
        },
        batchEmbed: async (batch) => {
          const byCustomId = await runOpenAiEmbeddingBatches({
            openAi: client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              method: "POST",
              url: OPENAI_BATCH_ENDPOINT,
              body: {
                model: client.model,
                input: chunk.text,
              },
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
      },
    };
  },
};

const geminiAdapter: MemoryEmbeddingProviderAdapter = {
  id: "gemini",
  defaultModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
  transport: "remote",
  autoSelectPriority: 30,
  allowExplicitWhenConfiguredAuto: true,
  supportsMultimodalEmbeddings: ({ model }) => supportsGeminiMultimodalEmbeddings(model),
  shouldContinueAutoSelection: isMissingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createGeminiEmbeddingProvider({
      ...options,
      provider: "gemini",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "gemini",
        cacheKeyData: {
          provider: "gemini",
          baseUrl: client.baseUrl,
          model: client.model,
          outputDimensionality: client.outputDimensionality,
          headers: sanitizeHeaders(client.headers, ["authorization", "x-goog-api-key"]),
        },
        batchEmbed: async (batch) => {
          if (batch.chunks.some((chunk) => hasNonTextEmbeddingParts(chunk.embeddingInput))) {
            return null;
          }
          const byCustomId = await runGeminiEmbeddingBatches({
            gemini: client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              request: buildGeminiEmbeddingRequest({
                input: chunk.embeddingInput ?? { text: chunk.text },
                taskType: "RETRIEVAL_DOCUMENT",
                modelPath: client.modelPath,
                outputDimensionality: client.outputDimensionality,
              }),
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
      },
    };
  },
};

const voyageAdapter: MemoryEmbeddingProviderAdapter = {
  id: "voyage",
  defaultModel: DEFAULT_VOYAGE_EMBEDDING_MODEL,
  transport: "remote",
  autoSelectPriority: 40,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createVoyageEmbeddingProvider({
      ...options,
      provider: "voyage",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "voyage",
        batchEmbed: async (batch) => {
          const byCustomId = await runVoyageEmbeddingBatches({
            client,
            agentId: batch.agentId,
            requests: batch.chunks.map((chunk, index) => ({
              custom_id: String(index),
              body: {
                input: chunk.text,
              },
            })),
            wait: batch.wait,
            concurrency: batch.concurrency,
            pollIntervalMs: batch.pollIntervalMs,
            timeoutMs: batch.timeoutMs,
            debug: batch.debug,
          });
          return mapBatchEmbeddingsByIndex(byCustomId, batch.chunks.length);
        },
      },
    };
  },
};

const mistralAdapter: MemoryEmbeddingProviderAdapter = {
  id: "mistral",
  defaultModel: DEFAULT_MISTRAL_EMBEDDING_MODEL,
  transport: "remote",
  autoSelectPriority: 50,
  allowExplicitWhenConfiguredAuto: true,
  shouldContinueAutoSelection: isMissingApiKeyError,
  create: async (options) => {
    const { provider, client } = await createMistralEmbeddingProvider({
      ...options,
      provider: "mistral",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "mistral",
        cacheKeyData: {
          provider: "mistral",
          model: client.model,
        },
      },
    };
  },
};

const lmstudioAdapter: MemoryEmbeddingProviderAdapter = {
  id: "lmstudio",
  defaultModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
  transport: "remote",
  create: async (options) => {
    const { provider, client } = await createLmstudioEmbeddingProvider({
      ...options,
      provider: "lmstudio",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "lmstudio",
        cacheKeyData: {
          provider: "lmstudio",
          baseUrl: client.baseUrl,
          model: client.model,
          headers: sanitizeHeaders(client.headers, ["authorization"]),
        },
      },
    };
  },
};

const localAdapter: MemoryEmbeddingProviderAdapter = {
  id: "local",
  defaultModel: DEFAULT_LOCAL_MODEL,
  transport: "local",
  autoSelectPriority: 10,
  formatSetupError: formatLocalSetupError,
  shouldContinueAutoSelection: () => true,
  create: async (options) => {
    const provider = await createLocalEmbeddingProvider({
      ...options,
      provider: "local",
      fallback: "none",
    });
    return {
      provider,
      runtime: {
        id: "local",
        cacheKeyData: {
          provider: "local",
          model: provider.model,
        },
      },
    };
  },
};

export const builtinMemoryEmbeddingProviderAdapters = [
  localAdapter,
  openAiAdapter,
  geminiAdapter,
  voyageAdapter,
  mistralAdapter,
  lmstudioAdapter,
] as const;

const builtinMemoryEmbeddingProviderAdapterById = new Map(
  builtinMemoryEmbeddingProviderAdapters.map((adapter) => [adapter.id, adapter]),
);

export function getBuiltinMemoryEmbeddingProviderAdapter(
  id: string,
): MemoryEmbeddingProviderAdapter | undefined {
  return builtinMemoryEmbeddingProviderAdapterById.get(id);
}

export function registerBuiltInMemoryEmbeddingProviders(register: {
  registerMemoryEmbeddingProvider: (adapter: MemoryEmbeddingProviderAdapter) => void;
}): void {
  // Only inspect providers already registered in the current load. Falling back
  // to capability discovery here can recursively trigger plugin loading while
  // memory-core itself is still registering.
  for (const adapter of filterUnregisteredMemoryEmbeddingProviderAdapters({
    builtinAdapters: builtinMemoryEmbeddingProviderAdapters,
    registeredAdapters: listRegisteredMemoryEmbeddingProviderAdapters(),
  })) {
    register.registerMemoryEmbeddingProvider(adapter);
  }
}

export function getBuiltinMemoryEmbeddingProviderDoctorMetadata(
  providerId: string,
): BuiltinMemoryEmbeddingProviderDoctorMetadata | null {
  const adapter = getBuiltinMemoryEmbeddingProviderAdapter(providerId);
  if (!adapter) {
    return null;
  }
  const authProviderId = resolveMemoryEmbeddingAuthProviderId(adapter.id);
  return {
    providerId: adapter.id,
    authProviderId,
    envVars: getProviderEnvVars(authProviderId),
    transport: adapter.transport === "local" ? "local" : "remote",
    autoSelectPriority: adapter.autoSelectPriority,
  };
}

export function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata(): Array<BuiltinMemoryEmbeddingProviderDoctorMetadata> {
  return builtinMemoryEmbeddingProviderAdapters
    .filter((adapter) => typeof adapter.autoSelectPriority === "number")
    .toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0))
    .map((adapter) => ({
      providerId: adapter.id,
      authProviderId: resolveMemoryEmbeddingAuthProviderId(adapter.id),
      envVars: getProviderEnvVars(resolveMemoryEmbeddingAuthProviderId(adapter.id)),
      transport: adapter.transport === "local" ? "local" : "remote",
      autoSelectPriority: adapter.autoSelectPriority,
    }));
}

export {
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
  DEFAULT_LOCAL_MODEL,
  DEFAULT_MISTRAL_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_VOYAGE_EMBEDDING_MODEL,
  canAutoSelectLocal,
  formatLocalSetupError,
  isMissingApiKeyError,
};
