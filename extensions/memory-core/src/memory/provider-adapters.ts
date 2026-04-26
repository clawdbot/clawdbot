import fsSync from "node:fs";
import {
  createLocalEmbeddingProvider,
  DEFAULT_LOCAL_MODEL,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveUserPath } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { getProviderEnvVars } from "openclaw/plugin-sdk/provider-env-vars";
import { formatErrorMessage } from "../dreaming-shared.js";
import { filterUnregisteredMemoryEmbeddingProviderAdapters } from "./provider-adapter-registration.js";

const NODE_LLAMA_CPP_RUNTIME_PACKAGE = "node-llama-cpp";
const NODE_LLAMA_CPP_RUNTIME_VERSION = "3.18.1";
const NODE_LLAMA_CPP_INSTALL_SPEC = `${NODE_LLAMA_CPP_RUNTIME_PACKAGE}@${NODE_LLAMA_CPP_RUNTIME_VERSION}`;

export type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
};

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as Error & { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && err.message.includes(NODE_LLAMA_CPP_RUNTIME_PACKAGE);
}

function listRemoteEmbeddingSetupHints(): string[] {
  try {
    return listMemoryEmbeddingProviders()
      .filter(
        (adapter) =>
          adapter.transport === "remote" && typeof adapter.autoSelectPriority === "number",
      )
      .toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0))
      .map((adapter) => `Or set agents.defaults.memorySearch.provider = "${adapter.id}" (remote).`);
  } catch {
    return [];
  }
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
      ? `2) Install optional local embedding runtime next to OpenClaw: npm i -g ${NODE_LLAMA_CPP_INSTALL_SPEC}`
      : null,
    `3) If you use pnpm: pnpm approve-builds (select ${NODE_LLAMA_CPP_RUNTIME_PACKAGE}), then pnpm rebuild ${NODE_LLAMA_CPP_RUNTIME_PACKAGE}`,
    ...listRemoteEmbeddingSetupHints(),
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
        inlineQueryTimeoutMs: 5 * 60_000,
        inlineBatchTimeoutMs: 10 * 60_000,
        cacheKeyData: {
          provider: "local",
          model: provider.model,
        },
      },
    };
  },
};

export const builtinMemoryEmbeddingProviderAdapters = [localAdapter] as const;

export { DEFAULT_LOCAL_MODEL };

export function getBuiltinMemoryEmbeddingProviderAdapter(
  id: string,
): MemoryEmbeddingProviderAdapter | undefined {
  return listMemoryEmbeddingProviders().find((adapter) => adapter.id === id);
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
  const authProviderId = adapter.authProviderId ?? adapter.id;
  return {
    providerId: adapter.id,
    authProviderId,
    envVars: getProviderEnvVars(authProviderId),
    transport: adapter.transport === "local" ? "local" : "remote",
    autoSelectPriority: adapter.autoSelectPriority,
  };
}

export function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata(): Array<BuiltinMemoryEmbeddingProviderDoctorMetadata> {
  return listMemoryEmbeddingProviders()
    .filter((adapter) => typeof adapter.autoSelectPriority === "number")
    .toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0))
    .map((adapter) => {
      const authProviderId = adapter.authProviderId ?? adapter.id;
      return {
        providerId: adapter.id,
        authProviderId,
        envVars: getProviderEnvVars(authProviderId),
        transport: adapter.transport === "local" ? "local" : "remote",
        autoSelectPriority: adapter.autoSelectPriority,
      };
    });
}

export { canAutoSelectLocal, formatLocalSetupError };
