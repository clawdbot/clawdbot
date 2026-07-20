/** Construction and owner identity for prepared model runtime generations. */
import path from "node:path";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { MODEL_APIS } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withTimeout } from "../node-host/with-timeout.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { discoverAuthStorage, discoverModels } from "./agent-model-discovery.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { loadBundledProviderStaticCatalogContextModels } from "./embedded-agent-runner/model.static-catalog.js";
import { buildPreparedModelCatalogSnapshot, type ModelCatalogEntry } from "./model-catalog.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import type { ModelRegistry } from "./sessions/model-registry.js";

const MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;

export type PreparedModelRuntimeSnapshot = Readonly<{
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  modelCatalog: ModelCatalogSnapshot;
  createStores: () => PreparedModelRuntimeStores;
}>;

export type PreparedModelRuntimeStores = {
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
};

export type PreparedModelRuntimeInput = {
  agentId?: string;
  agentDir: string;
  inheritedAuthDir?: string;
  workspaceDir?: string;
  preserveWorkspaceDirOnRefresh?: boolean;
  readOnly?: boolean;
  skipCredentials?: boolean;
  env?: NodeJS.ProcessEnv;
  config: OpenClawConfig;
};

export type PreparedModelRuntimeLease = Readonly<{
  snapshot: PreparedModelRuntimeSnapshot;
  release: () => void;
}>;

export type PreparedModelRuntimeOwner = {
  input: PreparedModelRuntimeInput;
  environmentFingerprint: string;
  provenance: "configured" | "standalone" | "explicit" | "run" | "ephemeral";
  generation: number;
  needsRefresh: boolean;
  refreshError?: Error;
  snapshot?: PreparedModelRuntimeSnapshot;
  pending?: Promise<PreparedModelRuntimeSnapshot>;
  buildCompletion?: Promise<void>;
  leaseCount?: number;
};

export type PreparedModelRuntimeReplacement = {
  gateId: PreparedModelRuntimeReplacementGateId;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};
export type PreparedModelRuntimeReplacementGateId = symbol;
export class PreparedModelRuntimeOwnerNotPublishedError extends Error {}

export class PreparedModelRuntimePublicationSupersededError extends PreparedModelRuntimeOwnerNotPublishedError {}

export function rebindInputToCommittedConfiguredOwner(
  owners: Map<string, PreparedModelRuntimeOwner>,
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeInput {
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const committed = [...owners.values()].filter(
    (owner) =>
      owner.provenance === "configured" && owner.snapshot && !owner.needsRefresh && !owner.pending,
  );
  const identityCandidates =
    input.agentId === undefined
      ? []
      : committed.filter((owner) => owner.input.agentId === input.agentId);
  const exactCandidates = identityCandidates.filter(
    (owner) => owner.input.agentDir === input.agentDir,
  );
  const directoryCandidates = committed.filter((owner) => owner.input.agentDir === input.agentDir);
  // Unbound inputs and reserved setup identities derive ownership from the configured directory.
  // Ordinary agent runs stay bound to their explicit identity, even when handed a stale directory.
  const canRebindByDirectory =
    input.agentId === undefined || isReservedSystemAgentId(input.agentId);
  const candidates =
    exactCandidates.length > 0
      ? exactCandidates
      : canRebindByDirectory && directoryCandidates.length > 0
        ? directoryCandidates
        : identityCandidates;
  if (candidates.length !== 1) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model runtime owner was not committed after replacement for ${input.agentDir}`,
    );
  }
  const owner = candidates[0]!;
  const preserveWorkspaceDir =
    input.preserveWorkspaceDirOnRefresh === true && input.workspaceDir !== undefined;
  // Reserved execution identities (for example setup's `openclaw` agent) intentionally borrow a
  // configured agent directory. Rebase their lifecycle inputs without erasing that run identity.
  const agentId = input.agentId ?? owner.input.agentId;
  return normalizePreparedModelRuntimeInput({
    ...input,
    ...(agentId ? { agentId } : {}),
    agentDir: owner.input.agentDir,
    config: owner.input.config,
    inheritedAuthDir: owner.input.inheritedAuthDir,
    env: owner.input.env,
    workspaceDir: preserveWorkspaceDir ? input.workspaceDir : owner.input.workspaceDir,
    preserveWorkspaceDirOnRefresh: preserveWorkspaceDir,
  });
}

/** Accepts canonical config clones without weakening projected-config isolation. */
export function preparedModelRuntimeConfigsMatch(
  left: OpenClawConfig,
  right: OpenClawConfig,
): boolean {
  if (left === right) {
    return true;
  }
  try {
    return hashRuntimeConfigValue(left) === hashRuntimeConfigValue(right);
  } catch {
    return false;
  }
}

export function normalizeOptionalDir(dirname: string | undefined): string | undefined {
  return dirname ? path.resolve(dirname) : undefined;
}

export function normalizePreparedModelRuntimeInput(
  input: PreparedModelRuntimeInput,
): PreparedModelRuntimeInput {
  const {
    inheritedAuthDir: _inheritedAuthDir,
    readOnly,
    skipCredentials,
    workspaceDir: _workspaceDir,
    ...rest
  } = input;
  const inheritedAuthDir = normalizeOptionalDir(
    input.inheritedAuthDir ?? resolveDefaultAgentDir(input.config, input.env),
  );
  const workspaceDir = normalizeOptionalDir(input.workspaceDir);
  const env = input.env ? Object.freeze({ ...input.env }) : undefined;
  return {
    ...rest,
    agentDir: path.resolve(input.agentDir),
    ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
    ...(readOnly === true ? { readOnly: true } : {}),
    ...(skipCredentials === true ? { skipCredentials: true } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(env ? { env } : {}),
  };
}

function environmentFingerprint(env: NodeJS.ProcessEnv | undefined): string | undefined {
  return env ? hashRuntimeConfigValue(env) : undefined;
}

export function effectiveEnvironmentFingerprint(input: PreparedModelRuntimeInput): string {
  return hashRuntimeConfigValue(input.env ?? process.env);
}

function isCatalogModelApi(
  value: string | undefined,
): value is NonNullable<ModelCatalogEntry["api"]> {
  return value !== undefined && (MODEL_APIS as readonly string[]).includes(value);
}

function toStaticCatalogEntry(
  model: Awaited<ReturnType<typeof loadBundledProviderStaticCatalogContextModels>>[number],
): ModelCatalogEntry {
  return {
    id: model.id,
    name: model.name ?? model.id,
    provider: model.provider,
    ...(isCatalogModelApi(model.api) ? { api: model.api } : {}),
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.input ? { input: model.input } : {}),
    ...(model.params ? { params: model.params } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.mediaInput ? { mediaInput: model.mediaInput } : {}),
  };
}

export function ownerKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    agentId: input.agentId,
    agentDir: input.agentDir,
    inheritedAuthDir: input.inheritedAuthDir,
    readOnly: input.readOnly === true,
    skipCredentials: input.skipCredentials === true,
    workspaceDir: input.workspaceDir,
    env: environmentFingerprint(input.env),
    config: input.readOnly ? hashRuntimeConfigValue(input.config) : undefined,
  });
}

export function resolvePublishedOwner(
  owners: Map<string, PreparedModelRuntimeOwner>,
  input: PreparedModelRuntimeInput,
  options: { allowConfiguredWorkspaceFallback?: boolean } = {},
): PreparedModelRuntimeOwner | undefined {
  const exact = owners.get(ownerKey(input));
  if (exact) {
    return exact;
  }
  if (!options.allowConfiguredWorkspaceFallback) {
    return undefined;
  }
  // Gateway launch may supply an authoritative workspace outside config. Request readers still
  // resolve the one configured lifecycle owner by agent; standalone/explicit owners remain exact.
  const candidates = [...owners.values()].filter(
    (owner) =>
      owner.provenance === "configured" &&
      (input.agentId === undefined || owner.input.agentId === input.agentId) &&
      owner.input.agentDir === input.agentDir &&
      owner.input.inheritedAuthDir === input.inheritedAuthDir &&
      owner.input.readOnly === input.readOnly &&
      owner.input.skipCredentials === input.skipCredentials &&
      (input.env === undefined ||
        owner.environmentFingerprint === environmentFingerprint(input.env)) &&
      (input.workspaceDir === undefined || owner.input.workspaceDir === input.workspaceDir),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function hasSameLifecycleInput(
  left: PreparedModelRuntimeInput,
  right: PreparedModelRuntimeInput,
): boolean {
  return (
    left.config === right.config &&
    left.agentId === right.agentId &&
    left.inheritedAuthDir === right.inheritedAuthDir &&
    left.readOnly === right.readOnly &&
    left.skipCredentials === right.skipCredentials &&
    left.workspaceDir === right.workspaceDir &&
    environmentFingerprint(left.env) === environmentFingerprint(right.env) &&
    left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh
  );
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createPreparedModelRuntimeReplacement(): PreparedModelRuntimeReplacement {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Readers await the original promise. This handler only prevents an unobserved rejected gate
  // when a reload fails before any request reaches the stale generation.
  void promise.catch(() => undefined);
  return { gateId: Symbol("prepared-model-runtime-replacement"), promise, resolve, reject };
}

export function listConfiguredOwnerInputs(
  config: OpenClawConfig,
  defaultWorkspaceDir?: string,
): PreparedModelRuntimeInput[] {
  const inheritedAuthDir = resolveDefaultAgentDir(config);
  const defaultAgentId = resolveDefaultAgentId(config);
  return listAgentIds(config).map((agentId) => {
    const preserveWorkspaceDirOnRefresh = agentId === defaultAgentId && defaultWorkspaceDir;
    const input: PreparedModelRuntimeInput = {
      agentId,
      agentDir: resolveAgentDir(config, agentId),
      config,
      inheritedAuthDir,
      workspaceDir: preserveWorkspaceDirOnRefresh
        ? defaultWorkspaceDir
        : resolveAgentWorkspaceDir(config, agentId),
    };
    if (preserveWorkspaceDirOnRefresh) {
      input.preserveWorkspaceDirOnRefresh = true;
    }
    return input;
  });
}

async function buildSnapshot(
  input: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  const env = input.env ?? process.env;
  if (!input.readOnly) {
    // Writable lifecycle publication owns process-global runtime plugin activation. Read-only
    // drafts consume manifest metadata only and must not mutate live hooks outside that gate.
    ensureRuntimePluginsLoaded({
      config: input.config,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    });
  }
  const pluginMetadataSnapshot = resolvePluginMetadataSnapshot({
    config: input.config,
    env,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  if (!input.readOnly) {
    await ensureOpenClawModelsJson(input.config, input.agentDir, {
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
      ...(input.env ? { env } : {}),
      providerDiscoveryTimeoutMs: MODEL_RUNTIME_PROVIDER_DISCOVERY_TIMEOUT_MS,
    });
  }
  const templateAuthStorage = discoverAuthStorage(input.agentDir, {
    config: input.config,
    // Snapshot construction never initializes, migrates, or externally syncs auth. A writable
    // generation performs its file preparation above; ModelRegistry discovery only parses it.
    readOnly: true,
    ...(input.skipCredentials ? { skipCredentials: true } : {}),
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  });
  const templateModelRegistry = discoverModels(templateAuthStorage, input.agentDir, {
    config: input.config,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  });
  const credentials = templateAuthStorage.getAll();
  const modelCatalog = await buildPreparedModelCatalogSnapshot({
    agentDir: input.agentDir,
    authCredentials: credentials,
    config: input.config,
    modelRegistry: templateModelRegistry,
    metadataSnapshot: pluginMetadataSnapshot,
    ...(input.env ? { env } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
  });
  const staticEntries = (
    await loadBundledProviderStaticCatalogContextModels({
      cfg: input.config,
      env,
      ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    })
  ).map(toStaticCatalogEntry);
  const createStores = (): PreparedModelRuntimeStores => {
    // Runtime API keys and session extensions mutate these objects. Fork them per run while the
    // credential map and parsed catalog remain owned by the lifecycle snapshot.
    const authStorage = AuthStorage.inMemory(credentials);
    return { authStorage, modelRegistry: templateModelRegistry.fork(authStorage) };
  };
  return Object.freeze({
    ...(input.agentId ? { agentId: input.agentId } : {}),
    agentDir: input.agentDir,
    ...(input.inheritedAuthDir ? { inheritedAuthDir: input.inheritedAuthDir } : {}),
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    config: input.config,
    metadataSnapshot: pluginMetadataSnapshot,
    modelCatalog: { ...modelCatalog, staticEntries },
    createStores,
  });
}

export function startSerializedSnapshotBuild(
  input: PreparedModelRuntimeInput,
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
): {
  pending: Promise<PreparedModelRuntimeSnapshot>;
  completion: Promise<void>;
} {
  const previousBuildCompletion = agentBuildCompletions.get(input.agentDir);
  // Lifecycle events may overlap. The timeout covers queueing plus this build, while completion
  // follows the real work so a timed-out generation can never overlap a replacement.
  const startBuild = (async () => {
    if (previousBuildCompletion) {
      await previousBuildCompletion;
    }
    return { actualBuild: buildSnapshot(input) };
  })();
  const completion = startBuild
    .then(async ({ actualBuild }) => await actualBuild)
    .then(
      () => undefined,
      () => undefined,
    );
  agentBuildCompletions.set(input.agentDir, completion);
  void completion.then(() => {
    if (agentBuildCompletions.get(input.agentDir) === completion) {
      agentBuildCompletions.delete(input.agentDir);
    }
  });
  return {
    pending: withTimeout(
      async () => {
        const { actualBuild } = await startBuild;
        return await actualBuild;
      },
      buildTimeoutMs,
      "prepared model runtime publication",
    ),
    completion,
  };
}

export async function publishModelRuntimeSnapshot(
  input: PreparedModelRuntimeInput,
  owners: Map<string, PreparedModelRuntimeOwner>,
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  existing?: PreparedModelRuntimeOwner,
  provenance: PreparedModelRuntimeOwner["provenance"] = "explicit",
): Promise<PreparedModelRuntimeSnapshot> {
  const key = ownerKey(input);
  const owner: PreparedModelRuntimeOwner = existing ?? {
    input,
    environmentFingerprint: effectiveEnvironmentFingerprint(input),
    provenance,
    generation: 0,
    needsRefresh: false,
  };
  owner.input = input;
  owner.environmentFingerprint = effectiveEnvironmentFingerprint(input);
  owner.provenance = provenance;
  owner.generation += 1;
  owner.needsRefresh = true;
  owner.refreshError = undefined;
  const generation = owner.generation;
  const build = startSerializedSnapshotBuild(input, agentBuildCompletions, buildTimeoutMs);
  owner.buildCompletion = build.completion;
  void build.completion.then(() => {
    if (owner.buildCompletion === build.completion) {
      owner.buildCompletion = undefined;
    }
  });
  owners.set(key, owner);
  const publication = (async () => {
    try {
      const snapshot = await build.pending;
      if (owner.generation !== generation || owners.get(key) !== owner) {
        throw new PreparedModelRuntimePublicationSupersededError(
          `prepared model runtime publication was superseded for ${input.agentDir}`,
        );
      }
      owner.snapshot = snapshot;
      owner.pending = undefined;
      owner.needsRefresh = false;
      return snapshot;
    } catch (error) {
      const refreshError = toError(error);
      if (owner.generation === generation && owners.get(key) === owner) {
        owner.pending = undefined;
        owner.needsRefresh = true;
        owner.refreshError = refreshError;
      }
      throw refreshError;
    }
  })();
  // Every waiter observes the publication guard, not the underlying discovery result. This keeps
  // invalidated generations from escaping even when callers deduplicate against pending work.
  owner.pending = publication;
  return await publication;
}
