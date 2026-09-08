import path from "node:path";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveSubagentSpawnModelFallbacksOverride,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  resolveSelectedAgentHarnessRuntime,
  type AgentHarnessPluginSelection,
} from "./harness/runtime-plugin-load-plan.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "./model-selection-config.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { copyPreparedModelRuntimeAuthBindings } from "./prepared-model-runtime-auth.js";
import {
  startSerializedSnapshotBuildBatch,
  type PreparedModelRuntimeBuildResult,
} from "./prepared-model-runtime.build.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "./prepared-model-runtime.errors.js";
import { retirePreparedModelRuntimeOwnerIfUnused } from "./prepared-model-runtime.retention.js";
import type {
  PreparedModelRuntimeBuildStats,
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePluginGeneration,
  PreparedModelRuntimeReplacement,
  PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.types.js";

const ownersBySnapshot = new WeakMap<PreparedModelRuntimeSnapshot, PreparedModelRuntimeOwner>();

export function resolvePreparedModelRuntimeOwnerBySnapshot(
  snapshot: PreparedModelRuntimeSnapshot,
): PreparedModelRuntimeOwner | undefined {
  return ownersBySnapshot.get(snapshot);
}

function publishPreparedModelRuntimeOwnerSnapshot(
  owner: PreparedModelRuntimeOwner,
  snapshot: PreparedModelRuntimeSnapshot,
): PreparedModelRuntimeSnapshot {
  const published = stampPreparedModelRuntimeSnapshotConfig(snapshot, owner.input.config);
  if (owner.snapshot) {
    ownersBySnapshot.delete(owner.snapshot);
  }
  owner.snapshot = published;
  ownersBySnapshot.set(published, owner);
  return published;
}

export type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimePublicationOptions,
  PreparedModelRuntimeRefreshOptions,
  PreparedModelRuntimeReplacement,
  PreparedModelRuntimeReplacementGateId,
  PreparedReplyDispatchRuntime,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.types.js";

export function prepareModelRuntimeOwner(
  input: PreparedModelRuntimeInput,
  provenance: PreparedModelRuntimeOwner["provenance"],
  catalogMode: PreparedModelRuntimeCatalogMode = "live",
  existing?: PreparedModelRuntimeOwner,
): PreparedModelRuntimeOwner {
  // Preparation precedes async discovery; neither an old nor unpublished snapshot owns these facts.
  return Object.assign(existing ?? { generation: 0, needsRefresh: true, catalogStale: false }, {
    input,
    catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
    environmentFingerprint: effectiveEnvironmentFingerprint(input),
    catalogMode,
    provenance,
  });
}

export {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
};

function findConfiguredOwnerCandidates(
  owners: Map<string, PreparedModelRuntimeOwner>,
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeOwner[] {
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const configured = [...owners.values()].filter((owner) => owner.provenance === "configured");
  const identityCandidates =
    input.agentId === undefined
      ? []
      : configured.filter((owner) => owner.input.agentId === input.agentId);
  const exactCandidates = identityCandidates.filter(
    (owner) => owner.input.agentDir === input.agentDir,
  );
  const directoryCandidates = configured.filter((owner) => owner.input.agentDir === input.agentDir);
  // Unbound inputs and reserved setup identities derive ownership from the configured directory.
  // Ordinary agent runs stay bound to their explicit identity, even when handed a stale directory.
  const canRebindByDirectory =
    input.agentId === undefined || isReservedSystemAgentId(input.agentId);
  return exactCandidates.length > 0
    ? exactCandidates
    : canRebindByDirectory && directoryCandidates.length > 0
      ? directoryCandidates
      : identityCandidates;
}

export function resolveConfiguredOwnerPublication(
  owners: Map<string, PreparedModelRuntimeOwner>,
  rawInput: PreparedModelRuntimeInput,
): { matches: boolean; pending?: Promise<PreparedModelRuntimeSnapshot> } {
  const candidates = findConfiguredOwnerCandidates(owners, rawInput);
  return {
    matches: candidates.length > 0,
    pending: candidates.length === 1 ? candidates[0]?.pending : undefined,
  };
}

export function resolveConfiguredOwner(
  owners: Map<string, PreparedModelRuntimeOwner>,
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeOwner | undefined {
  const candidates = findConfiguredOwnerCandidates(owners, rawInput);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveCommittedConfiguredOwner(
  owners: Map<string, PreparedModelRuntimeOwner>,
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeOwner | undefined {
  const candidates = findConfiguredOwnerCandidates(owners, rawInput).filter(
    (owner) => owner.snapshot && !owner.needsRefresh && !owner.pending,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function rebindInputToCommittedConfiguredOwner(
  owners: Map<string, PreparedModelRuntimeOwner>,
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeInput {
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const owner = resolveCommittedConfiguredOwner(owners, rawInput);
  if (!owner) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared model runtime owner was not committed after replacement for ${input.agentDir}`,
    );
  }
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
    allowGatewaySubagentBinding:
      input.allowGatewaySubagentBinding ?? owner.input.allowGatewaySubagentBinding,
    runtimePluginSelections: input.runtimePluginSelections ?? owner.input.runtimePluginSelections,
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

function stampPreparedModelRuntimeSnapshotConfig(
  snapshot: PreparedModelRuntimeSnapshot,
  config: OpenClawConfig,
): PreparedModelRuntimeSnapshot {
  if (snapshot.config === config) {
    return snapshot;
  }
  const stamped = Object.freeze({ ...snapshot, config });
  copyPreparedModelRuntimeAuthBindings(snapshot, stamped);
  return stamped;
}

export function advancePreparedModelRuntimeOwnerConfig(
  owner: PreparedModelRuntimeOwner,
  config: OpenClawConfig,
): void {
  owner.input = { ...owner.input, config };
  if (owner.snapshot) {
    // Existing leases retain their immutable snapshot. New readers receive the same prepared
    // generation with only its planner-approved, model-neutral config stamp advanced.
    publishPreparedModelRuntimeOwnerSnapshot(owner, owner.snapshot);
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
    runtimePluginSelections: _runtimePluginSelections,
    skipCredentials,
    workspaceDir: _workspaceDir,
    ...rest
  } = input;
  const inheritedAuthDir = normalizeOptionalDir(
    input.inheritedAuthDir ?? resolveLegacyInheritedAuthDir(input.config, input.env),
  );
  const workspaceDir = normalizeOptionalDir(input.workspaceDir);
  const env = input.env ? Object.freeze({ ...input.env }) : undefined;
  const selections = new Map<string, AgentHarnessPluginSelection>();
  for (const selection of input.runtimePluginSelections ?? []) {
    const runtime = resolveSelectedAgentHarnessRuntime(selection, input.config);
    const { agentId: _agentId, ...normalized } = selection;
    const entry = Object.freeze({ ...normalized, runtime });
    selections.set(JSON.stringify(entry), entry);
  }
  const runtimePluginSelections = Object.freeze(
    [...selections]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, entry]) => entry),
  );
  return {
    ...rest,
    agentDir: path.resolve(input.agentDir),
    ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
    ...(readOnly === true ? { readOnly: true } : {}),
    ...(skipCredentials === true ? { skipCredentials: true } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(env ? { env } : {}),
    ...(input.allowGatewaySubagentBinding === true ? { allowGatewaySubagentBinding: true } : {}),
    ...(runtimePluginSelections?.length ? { runtimePluginSelections } : {}),
  };
}

function environmentFingerprint(env: NodeJS.ProcessEnv | undefined): string | undefined {
  return env ? hashRuntimeConfigValue(env) : undefined;
}

function effectiveEnvironmentFingerprint(input: PreparedModelRuntimeInput): string {
  return hashRuntimeConfigValue(input.env ?? process.env);
}

export function ownerKey(input: PreparedModelRuntimeInput): string {
  return JSON.stringify({
    agentId: input.agentId,
    agentDir: input.agentDir,
    inheritedAuthDir: input.inheritedAuthDir,
    readOnly: input.readOnly === true,
    loadRuntimePlugins: input.loadRuntimePlugins === true,
    skipCredentials: input.skipCredentials === true,
    workspaceDir: input.workspaceDir,
    env: environmentFingerprint(input.env),
    allowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
    runtimePluginSelections: input.runtimePluginSelections,
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
      owner.input.loadRuntimePlugins === input.loadRuntimePlugins &&
      owner.input.skipCredentials === input.skipCredentials &&
      // Binding is a publication-time build capability readers cannot know;
      // absent (= undefined after normalization) is a wildcard like the
      // clauses below. Requiring equality made every flagless gateway reader
      // (models.list, catalog loads) miss the configured owner and silently
      // rebuild a live ephemeral catalog per request.
      (input.allowGatewaySubagentBinding === undefined ||
        owner.input.allowGatewaySubagentBinding === input.allowGatewaySubagentBinding) &&
      (input.runtimePluginSelections === undefined ||
        JSON.stringify(owner.input.runtimePluginSelections) ===
          JSON.stringify(input.runtimePluginSelections)) &&
      (input.env === undefined ||
        owner.environmentFingerprint === environmentFingerprint(input.env)) &&
      (input.workspaceDir === undefined || owner.input.workspaceDir === input.workspaceDir),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Reads an already-published generation without admitting discovery. */
export function readPublishedModelRuntimeSnapshot(
  owners: Map<string, PreparedModelRuntimeOwner>,
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeSnapshot | undefined {
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const owner = resolvePublishedOwner(owners, input, {
    allowConfiguredWorkspaceFallback:
      rawInput.workspaceDir === undefined ||
      rawInput.agentId === undefined ||
      rawInput.runtimePluginSelections === undefined,
  });
  if (!owner?.snapshot || owner.needsRefresh || owner.pending) {
    return undefined;
  }
  if (input.readOnly && !preparedModelRuntimeConfigsMatch(owner.input.config, input.config)) {
    return undefined;
  }
  return owner.snapshot;
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
    left.loadRuntimePlugins === right.loadRuntimePlugins &&
    left.skipCredentials === right.skipCredentials &&
    left.workspaceDir === right.workspaceDir &&
    environmentFingerprint(left.env) === environmentFingerprint(right.env) &&
    left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh &&
    left.allowGatewaySubagentBinding === right.allowGatewaySubagentBinding &&
    JSON.stringify(left.runtimePluginSelections) === JSON.stringify(right.runtimePluginSelections)
  );
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
  allowGatewaySubagentBinding?: boolean,
): PreparedModelRuntimeInput[] {
  const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(config);
  const inheritedAuthDir = resolveLegacyInheritedAuthDir(config);
  return listAgentIds(config).map((agentId) => {
    const preserveWorkspaceDirOnRefresh = agentId === compatibilityAgentId && defaultWorkspaceDir;
    const input: PreparedModelRuntimeInput = {
      agentId,
      agentDir: resolveAgentDir(config, agentId),
      config,
      inheritedAuthDir,
      workspaceDir: preserveWorkspaceDirOnRefresh
        ? defaultWorkspaceDir
        : resolveAgentWorkspaceDir(config, agentId),
      runtimePluginSelections: resolveConfiguredRuntimePluginSelections(config, agentId),
    };
    if (allowGatewaySubagentBinding === true) {
      input.allowGatewaySubagentBinding = true;
    }
    if (preserveWorkspaceDirOnRefresh) {
      input.preserveWorkspaceDirOnRefresh = true;
    }
    return input;
  });
}

function resolveConfiguredRuntimePluginSelections(
  config: OpenClawConfig,
  agentId: string,
): PreparedModelRuntimeInput["runtimePluginSelections"] {
  const configured = resolveDefaultModelForAgent({ cfg: config, agentId });
  const subagentModel = resolveSubagentConfiguredModelSelection({
    cfg: config,
    agentId,
    includeAgentPrimary: false,
  });
  return resolveModelCandidateChain({
    cfg: config,
    agentId,
    manifestPlugins: [],
    provider: configured.provider || DEFAULT_PROVIDER,
    model: configured.model || DEFAULT_MODEL,
    requestedRouteResolution: "resolved",
    // Session policy can narrow either configured chain after admission waits. Prepare
    // their owners once so nested execution never expands an already frozen generation.
    fallbacksOverride: [
      ...resolveConfiguredModelFallbacks({ cfg: config, agentId }),
      ...(subagentModel ? [subagentModel] : []),
      ...(resolveSubagentSpawnModelFallbacksOverride(config, agentId) ?? []),
    ],
  }).map((candidate) => ({
    provider: candidate.provider,
    modelId: candidate.model,
    agentId,
  }));
}

export async function publishPreparedModelRuntimeOwnerBatch(params: {
  entries: Array<{
    owner: PreparedModelRuntimeOwner;
    input: PreparedModelRuntimeInput;
  }>;
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  buildTimeoutMs: number;
  includeCredentialProviders?: boolean;
  isPublicationCurrent?: () => boolean;
  isBuildCurrent?: () => boolean;
  onBuildStats?: (stats: PreparedModelRuntimeBuildStats) => void;
  registerEntriesAfterBuildStart?: boolean;
  reusePluginGenerations?: boolean;
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"];
}): Promise<void> {
  const candidates = params.entries.map(({ owner }) => {
    const input = owner.input;
    owner.environmentFingerprint = effectiveEnvironmentFingerprint(input);
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = undefined;
    owner.pendingPluginGeneration = params.reusePluginGenerations
      ? owner.pluginGeneration
      : undefined;
    const generation = owner.generation;
    const key = ownerKey(input);
    let registered = params.owners.get(key) === owner;
    // Scoped reloads retain unaffected generations beyond their creating publication epoch.
    // Persistent catalog/auth callbacks must retire only with this exact registered generation.
    const isGenerationCurrent = () =>
      owner.generation === generation && params.owners.get(key) === owner;
    const isCurrent = () => (params.isPublicationCurrent?.() ?? true) && isGenerationCurrent();
    return {
      catalogMode: owner.catalogMode,
      input,
      catalogOwner: owner.catalogOwner,
      inventoryOwner: owner,
      pluginGeneration: owner.pendingPluginGeneration,
      prepareInboundPluginRegistry: owner.provenance === "configured",
      isGenerationCurrent,
      isBuildCurrent: params.isBuildCurrent ?? isCurrent,
      isPreparationCurrent: params.isBuildCurrent,
      isEligible: () =>
        (params.isPublicationCurrent?.() ?? true) &&
        owner.generation === generation &&
        (registered
          ? params.owners.get(key) === owner
          : params.registerEntriesAfterBuildStart === true),
      isCurrent,
      key,
      generation,
      markRegistered: () => {
        registered = true;
      },
      owner,
    };
  });
  const groups = new Map<PreparedModelRuntimeOwner["catalogMode"], typeof candidates>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.catalogMode);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(candidate.catalogMode, [candidate]);
    }
  }
  const results = new Map<PreparedModelRuntimeOwner, PreparedModelRuntimeBuildResult>();
  const publication = (async () => {
    try {
      while (true) {
        const attempt = candidates.filter(
          (candidate) => candidate.isEligible() && !results.has(candidate.owner),
        );
        if (attempt.length === 0) {
          break;
        }
        try {
          // Auth events can touch live and static owners together. Build mode groups in sequence
          // so one mutation cannot reintroduce broad plugin/catalog fanout on constrained hosts.
          for (const [catalogMode, group] of groups) {
            const currentGroup = group.filter(
              (candidate) => candidate.isEligible() && !results.has(candidate.owner),
            );
            if (currentGroup.length === 0) {
              continue;
            }
            const build = startSerializedSnapshotBuildBatch(
              currentGroup,
              params.agentBuildCompletions,
              params.buildTimeoutMs,
              catalogMode,
              params.onBuildStats,
              params.pluginMetadataSnapshot,
              params.includeCredentialProviders,
            );
            for (const candidate of currentGroup) {
              if (params.registerEntriesAfterBuildStart === true) {
                // First-build hooks may emit auth mutations. Publish the owner only after those
                // hooks start so an event cannot refresh a generation that was not visible yet.
                params.owners.set(candidate.key, candidate.owner);
                candidate.markRegistered();
              }
              candidate.owner.buildCompletion = build.completion;
              void build.completion.then(() => {
                if (candidate.owner.buildCompletion === build.completion) {
                  candidate.owner.buildCompletion = undefined;
                }
              });
            }
            const built = await build.pending;
            for (const [index, candidate] of currentGroup.entries()) {
              results.set(candidate.owner, built[index]!);
            }
          }
          break;
        } catch (error) {
          const refreshError = toStringifiedError(error);
          const lostCandidate = attempt.some((candidate) => !candidate.isCurrent());
          if (
            !(refreshError instanceof PreparedModelRuntimePublicationSupersededError) ||
            !(params.isPublicationCurrent?.() ?? true) ||
            !lostCandidate
          ) {
            throw refreshError;
          }
          // Supersession belongs to one owner generation. Retry only still-current siblings so
          // an agent-local mutation cannot discard an inherited-auth refresh built for others.
        }
      }
      for (const candidate of candidates) {
        if (candidate.owner.generation === candidate.generation) {
          candidate.owner.pendingPluginGeneration = undefined;
        }
        if (!candidate.isCurrent()) {
          continue;
        }
        const result = results.get(candidate.owner);
        if (!result) {
          throw new Error(
            `prepared model runtime snapshot missing after auth refresh for ${candidate.input.agentDir}`,
          );
        }
        const snapshot = publishPreparedModelRuntimeOwnerSnapshot(candidate.owner, result.snapshot);
        results.set(candidate.owner, { ...result, snapshot });
        candidate.owner.pluginGeneration = result.pluginGeneration;
        candidate.owner.needsRefresh = false;
      }
    } catch (error) {
      const refreshError = toStringifiedError(error);
      for (const candidate of candidates) {
        if (candidate.owner.generation === candidate.generation) {
          candidate.owner.pendingPluginGeneration = undefined;
        }
        if (!candidate.isCurrent()) {
          continue;
        }
        candidate.owner.needsRefresh = true;
        candidate.owner.refreshError = refreshError;
      }
      throw refreshError;
    }
  })();
  await publication;
}

export async function publishModelRuntimeSnapshot(
  input: PreparedModelRuntimeInput,
  owners: Map<string, PreparedModelRuntimeOwner>,
  agentBuildCompletions: Map<string, Promise<void>>,
  buildTimeoutMs: number,
  existing?: PreparedModelRuntimeOwner,
  provenance: PreparedModelRuntimeOwner["provenance"] = "explicit",
  catalogMode: PreparedModelRuntimeCatalogMode = existing?.catalogMode ?? "live",
  reusablePluginGeneration?: PreparedModelRuntimePluginGeneration,
  pluginMetadataSnapshot?: PreparedModelRuntimePluginGeneration["pluginMetadataSnapshot"],
): Promise<PreparedModelRuntimeSnapshot> {
  const key = ownerKey(input);
  const owner = prepareModelRuntimeOwner(input, provenance, catalogMode, existing);
  owner.generation += 1;
  owner.needsRefresh = true;
  owner.refreshError = undefined;
  owner.pluginGeneration = undefined;
  owner.pendingPluginGeneration = reusablePluginGeneration;
  const generation = owner.generation;
  const isGenerationCurrent = () => owner.generation === generation && owners.get(key) === owner;
  const build = startSerializedSnapshotBuildBatch(
    [
      {
        input,
        catalogOwner: owner.catalogOwner,
        inventoryOwner: owner,
        isGenerationCurrent,
        isBuildCurrent: isGenerationCurrent,
        prepareInboundPluginRegistry: provenance === "configured",
        pluginGeneration: reusablePluginGeneration,
      },
    ],
    agentBuildCompletions,
    buildTimeoutMs,
    catalogMode,
    undefined,
    pluginMetadataSnapshot,
  );
  owner.buildCompletion = build.completion;
  void build.completion.then(() => {
    if (owner.buildCompletion === build.completion) {
      owner.buildCompletion = undefined;
    }
  });
  owners.set(key, owner);
  const publication = (async () => {
    try {
      const result = (await build.pending)[0]!;
      if (!isGenerationCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          `prepared model runtime publication was superseded for ${input.agentDir}`,
        );
      }
      const snapshot = publishPreparedModelRuntimeOwnerSnapshot(owner, result.snapshot);
      owner.pluginGeneration = result.pluginGeneration;
      owner.pendingPluginGeneration = undefined;
      owner.pending = undefined;
      owner.needsRefresh = false;
      return snapshot;
    } catch (error) {
      const refreshError = toStringifiedError(error);
      if (owner.generation === generation) {
        owner.pendingPluginGeneration = undefined;
      }
      if (isGenerationCurrent()) {
        owner.pending = undefined;
        owner.needsRefresh = true;
        owner.refreshError = refreshError;
        if (!owner.snapshot) {
          retirePreparedModelRuntimeOwnerIfUnused(owners, key, owner);
        }
      }
      throw refreshError;
    }
  })();
  // Every waiter observes the publication guard, not the underlying discovery result. This keeps
  // invalidated generations from escaping even when callers deduplicate against pending work.
  owner.pending = publication;
  return await publication;
}
