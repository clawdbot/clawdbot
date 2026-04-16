import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { normalizeModelCompat } from "../plugins/provider-model-compat.js";
import {
  applyProviderResolvedModelCompatWithPlugins,
  applyProviderResolvedTransportWithPlugin,
  normalizeProviderResolvedModelWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
} from "../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import { isRecord } from "../utils.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { resolveProviderEnvApiKeyCandidates } from "./model-auth-env-vars.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";

const PiAuthStorageClass = PiCodingAgent.AuthStorage;
const PiModelRegistryClass = PiCodingAgent.ModelRegistry;

export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };

type ProviderRuntimeModelLike = Model<Api> & {
  contextTokens?: number;
};

type DiscoveredProviderRuntimeModelLike = Omit<ProviderRuntimeModelLike, "api"> & {
  api?: string | null;
};

type InMemoryAuthStorageBackendLike = {
  withLock<T>(
    update: (current: string) => {
      result: T;
      next?: string;
    },
  ): T;
};

function createInMemoryAuthStorageBackend(
  initialData: PiCredentialMap,
): InMemoryAuthStorageBackendLike {
  let snapshot = JSON.stringify(initialData, null, 2);
  return {
    withLock<T>(
      update: (current: string) => {
        result: T;
        next?: string;
      },
    ): T {
      const { result, next } = update(snapshot);
      if (typeof next === "string") {
        snapshot = next;
      }
      return result;
    },
  };
}

export function normalizeDiscoveredPiModel<T>(value: T, agentDir: string): T {
  if (!isRecord(value)) {
    return value;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.provider !== "string"
  ) {
    return value;
  }
  const model = value as unknown as DiscoveredProviderRuntimeModelLike;
  const pluginNormalized =
    normalizeProviderResolvedModelWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: model as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? model;
  const compatNormalized =
    applyProviderResolvedModelCompatWithPlugins({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: pluginNormalized as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? pluginNormalized;
  const transportNormalized =
    applyProviderResolvedTransportWithPlugin({
      provider: model.provider,
      context: {
        provider: model.provider,
        modelId: model.id,
        model: compatNormalized as unknown as ProviderRuntimeModelLike,
        agentDir,
      },
    }) ?? compatNormalized;
  if (
    !isRecord(transportNormalized) ||
    typeof transportNormalized.id !== "string" ||
    typeof transportNormalized.name !== "string" ||
    typeof transportNormalized.provider !== "string" ||
    typeof transportNormalized.api !== "string"
  ) {
    return value;
  }
  return normalizeModelCompat(transportNormalized as Model<Api>) as T;
}

type PiModelRegistryClassLike = {
  create?: (authStorage: PiAuthStorage, modelsJsonPath: string) => PiModelRegistry;
  new (authStorage: PiAuthStorage, modelsJsonPath: string): PiModelRegistry;
};

function instantiatePiModelRegistry(
  authStorage: PiAuthStorage,
  modelsJsonPath: string,
): PiModelRegistry {
  const Registry = PiModelRegistryClass as unknown as PiModelRegistryClassLike;
  if (typeof Registry.create === "function") {
    return Registry.create(authStorage, modelsJsonPath);
  }
  return new Registry(authStorage, modelsJsonPath);
}

function createOpenClawModelRegistry(
  authStorage: PiAuthStorage,
  modelsJsonPath: string,
  agentDir: string,
): PiModelRegistry {
  const registry = instantiatePiModelRegistry(authStorage, modelsJsonPath);
  const getAll = registry.getAll.bind(registry);
  const getAvailable = registry.getAvailable.bind(registry);
  const find = registry.find.bind(registry);

  registry.getAll = () =>
    getAll().map((entry: Model<Api>) => normalizeDiscoveredPiModel(entry, agentDir));
  registry.getAvailable = () =>
    getAvailable().map((entry: Model<Api>) => normalizeDiscoveredPiModel(entry, agentDir));
  registry.find = (provider: string, modelId: string) =>
    normalizeDiscoveredPiModel(find(provider, modelId), agentDir);

  return registry;
}

export function scrubLegacyStaticAuthJsonEntriesForDiscovery(pathname: string): void {
  if (process.env.OPENCLAW_AUTH_STORE_READONLY === "1") {
    return;
  }
  if (!fs.existsSync(pathname)) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  let changed = false;
  for (const [provider, value] of Object.entries(parsed)) {
    if (!isRecord(value)) {
      continue;
    }
    if (value.type !== "api_key") {
      continue;
    }
    delete parsed[provider];
    changed = true;
  }

  if (!changed) {
    return;
  }

  if (Object.keys(parsed).length === 0) {
    fs.rmSync(pathname, { force: true });
    return;
  }

  fs.writeFileSync(pathname, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function createAuthStorage(AuthStorageLike: unknown, path: string, creds: PiCredentialMap) {
  const withInMemory = AuthStorageLike as { inMemory?: (data?: unknown) => unknown };
  if (typeof withInMemory.inMemory === "function") {
    return withInMemory.inMemory(creds) as PiAuthStorage;
  }

  const withFromStorage = AuthStorageLike as {
    fromStorage?: (storage: unknown) => unknown;
  };
  if (typeof withFromStorage.fromStorage === "function") {
    const backendCtor = (
      PiCodingAgent as { InMemoryAuthStorageBackend?: new () => InMemoryAuthStorageBackendLike }
    ).InMemoryAuthStorageBackend;
    const backend =
      typeof backendCtor === "function"
        ? new backendCtor()
        : createInMemoryAuthStorageBackend(creds);
    backend.withLock(() => ({
      result: undefined,
      next: JSON.stringify(creds, null, 2),
    }));
    return withFromStorage.fromStorage(backend) as PiAuthStorage;
  }

  const withFactory = AuthStorageLike as { create?: (path: string) => unknown };
  const withRuntimeOverride = (
    typeof withFactory.create === "function"
      ? withFactory.create(path)
      : new (AuthStorageLike as { new (path: string): unknown })(path)
  ) as PiAuthStorage & {
    setRuntimeApiKey?: (provider: string, apiKey: string) => void; // pragma: allowlist secret
  };
  const hasRuntimeApiKeyOverride = typeof withRuntimeOverride.setRuntimeApiKey === "function"; // pragma: allowlist secret
  if (hasRuntimeApiKeyOverride) {
    for (const [provider, credential] of Object.entries(creds)) {
      if (credential.type === "api_key") {
        withRuntimeOverride.setRuntimeApiKey(provider, credential.key);
        continue;
      }
      withRuntimeOverride.setRuntimeApiKey(provider, credential.access);
    }
  }
  return withRuntimeOverride;
}

export function addEnvBackedPiCredentials(
  credentials: PiCredentialMap,
  env: NodeJS.ProcessEnv = process.env,
): PiCredentialMap {
  const next = { ...credentials };
  // pi-coding-agent hides providers from its registry when auth storage lacks
  // a matching credential entry. Mirror env-backed provider auth here so
  // live/model discovery sees the same providers runtime auth can use.
  for (const provider of Object.keys(resolveProviderEnvApiKeyCandidates({ env }))) {
    if (next[provider]) {
      continue;
    }
    const resolved = resolveEnvApiKey(provider, env);
    if (!resolved?.apiKey) {
      continue;
    }
    next[provider] = {
      type: "api_key",
      key: resolved.apiKey,
    };
  }
  return next;
}

export function resolvePiCredentialsForDiscovery(agentDir: string): PiCredentialMap {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const credentials = addEnvBackedPiCredentials(resolvePiCredentialMapFromStore(store));
  for (const provider of resolveRuntimeSyntheticAuthProviderRefs()) {
    if (credentials[provider]) {
      continue;
    }
    const resolved = resolveProviderSyntheticAuthWithPlugin({
      provider,
      context: {
        config: undefined,
        provider,
        providerConfig: undefined,
      },
    });
    const apiKey = resolved?.apiKey?.trim();
    if (!apiKey) {
      continue;
    }
    credentials[provider] = {
      type: "api_key",
      key: apiKey,
    };
  }
  return credentials;
}

// Compatibility helpers for pi-coding-agent 0.50+ (discover* helpers removed).
export function discoverAuthStorage(agentDir: string): PiAuthStorage {
  const credentials = resolvePiCredentialsForDiscovery(agentDir);
  const authPath = path.join(agentDir, "auth.json");
  scrubLegacyStaticAuthJsonEntriesForDiscovery(authPath);
  return createAuthStorage(PiAuthStorageClass, authPath, credentials);
}

export function discoverModels(authStorage: PiAuthStorage, agentDir: string): PiModelRegistry {
  return createOpenClawModelRegistry(authStorage, path.join(agentDir, "models.json"), agentDir);
}
