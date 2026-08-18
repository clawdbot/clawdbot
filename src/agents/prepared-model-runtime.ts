/** Lifecycle-owned auth/model discovery snapshots for agent runs. */
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { registerRuntimeAuthProfileStoreMutationListener } from "./auth-profiles/runtime-snapshots.js";
import { acquirePreparedModelRuntimeLeaseFromOwners } from "./prepared-model-runtime-lease.js";
import { registerPreparedRuntimeAuthMaterializationPublisher } from "./prepared-model-runtime-materializations.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimeOwnerRetention,
  PreparedModelRuntimePublicationSupersededError,
  createPreparedModelRuntimeOwner,
  createPreparedModelRuntimeReplacement,
  effectiveEnvironmentFingerprint,
  hasSameLifecycleInput,
  listConfiguredOwnerInputs,
  normalizeOptionalDir,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  preparedModelRuntimeConfigsMatch,
  publishPreparedModelRuntimeOwnerBatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  resolvePublishedOwner,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimePublicationOptions,
  type PreparedModelRuntimeRefreshOptions,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeReplacementGateId,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import {
  notifyPreparedModelRuntimePublication,
  resetPreparedModelRuntimePublicationListenersForTest,
} from "./prepared-model-runtime.publication-events.js";
import type { PreparedModelRuntimeCatalogMode } from "./prepared-model-runtime.types.js";
import { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";
export {
  PreparedModelRuntimeOwnerNotPublishedError,
  preparedModelRuntimeConfigsMatch,
} from "./prepared-model-runtime.owner.js";
export type { PreparedModelRuntimeReplacementGateId } from "./prepared-model-runtime.owner.js";
export { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
export type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
  PreparedReplyDispatchRuntime,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.owner.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
// This bound only detects hung builds; overlap safety comes from the completion
// chain, and a timeout here is fatal to gateway startup. Cold builds (plugin
// metadata + model catalog + stores) legitimately exceed 30s on slow or loaded
// hosts, so match the 120s startup-grace scale used by channel connect.
const DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS = 120_000;
let modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;

const owners = new Map<string, PreparedModelRuntimeOwner>();
const agentBuildCompletions = new Map<string, Promise<void>>();
const standaloneActivationTails = new Map<string, Promise<void>>();
const retainedDirectRunOwners = new PreparedModelRuntimeOwnerRetention(1);
const retainedGatewayRunOwners = new PreparedModelRuntimeOwnerRetention(8);
let gatewayLifecycleActive = false;
let refreshTail: Promise<void> = Promise.resolve();
let refreshRequestEpoch = 0;
let pendingModelRuntimeReplacement: PreparedModelRuntimeReplacement | undefined;
type AuthMutationEvent = { agentDir?: string; affectsInheritedStores: boolean };
const pendingAuthMutations: AuthMutationEvent[] = [];

const replyDispatchPublication = new PreparedReplyDispatchPublicationOwner({
  isGatewayLifecycleActive: () => gatewayLifecycleActive,
  getPendingReplacement: () => pendingModelRuntimeReplacement?.promise,
});
export const loadPublishedGatewayReplyDispatchRuntime = replyDispatchPublication.load;

/** Resolves a published owner or activates a standalone lifecycle owner. */
export async function loadPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  for (;;) {
    const replacement = pendingModelRuntimeReplacement;
    if (replacement) {
      await replacement.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(owners, input);
      continue;
    }
    try {
      return await prepareModelRuntimeSnapshot(input);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
    const activationGate = pendingModelRuntimeReplacement;
    if (activationGate) {
      await activationGate.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(owners, input);
      continue;
    }
    const activated = await activateStandalonePreparedModelRuntime(input);
    const replacementAfterActivation = pendingModelRuntimeReplacement;
    if (replacementAfterActivation) {
      await replacementAfterActivation.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(owners, input);
      continue;
    }
    if (!activated) {
      return await prepareModelRuntimeSnapshot(input);
    }
    try {
      return await prepareModelRuntimeSnapshot(input);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
      // A concurrent publication boundary may retire the standalone owner between build and read.
      // Retry only after proving that no replacement gate owns the next generation.
    }
  }
}

/** Returns an already-published generation without starting discovery. */
export function getPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): PreparedModelRuntimeSnapshot | undefined {
  if (pendingModelRuntimeReplacement) {
    return undefined;
  }
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

/** Publishes one owner from an explicit startup/activation lifecycle boundary. */
export async function publishPreparedModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
  options: PreparedModelRuntimePublicationOptions = {},
): Promise<PreparedModelRuntimeSnapshot> {
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const existing = owners.get(ownerKey(input));
  if (existing?.pending) {
    if (!options.force && hasSameLifecycleInput(existing.input, input)) {
      return await existing.pending;
    }
    return await publishModelRuntimeSnapshot(
      input,
      owners,
      agentBuildCompletions,
      modelRuntimeBuildTimeoutMs,
      existing,
      options.provenance,
      options.catalogMode,
    );
  }
  if (existing?.buildCompletion) {
    throw (
      existing.refreshError ??
      new Error(`prepared model runtime build is still settling for ${input.agentDir}`)
    );
  }
  if (
    existing?.snapshot &&
    !existing.needsRefresh &&
    !options.force &&
    hasSameLifecycleInput(existing.input, input)
  ) {
    return existing.snapshot;
  }
  return await publishModelRuntimeSnapshot(
    input,
    owners,
    agentBuildCompletions,
    modelRuntimeBuildTimeoutMs,
    existing,
    options.provenance,
    options.catalogMode,
  );
}

/** Activates lifecycle publication for direct embedded runtimes without a gateway startup. */
export async function activateStandalonePreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot | undefined> {
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const key = ownerKey(input);
  const previous = standaloneActivationTails.get(key) ?? Promise.resolve();
  // One writer per owner key prevents conflicting config activations from alternately
  // superseding each other's generation while preserving each caller's requested snapshot.
  const activation = previous.then(
    async () => await activateStandalonePreparedModelRuntimeNow(input),
  );
  const tail = activation.then(
    () => undefined,
    () => undefined,
  );
  standaloneActivationTails.set(key, tail);
  try {
    return await activation;
  } finally {
    if (standaloneActivationTails.get(key) === tail) {
      standaloneActivationTails.delete(key);
    }
  }
}

async function activateStandalonePreparedModelRuntimeNow(
  input: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot | undefined> {
  for (;;) {
    const overlapsConfiguredOwner = [...owners.values()].some(
      (owner) =>
        owner.provenance === "configured" &&
        owner.input.agentDir === input.agentDir &&
        (input.agentId === undefined || owner.input.agentId === input.agentId) &&
        (input.workspaceDir === undefined || owner.input.workspaceDir === input.workspaceDir),
    );
    if (gatewayLifecycleActive && (!input.readOnly || overlapsConfiguredOwner)) {
      // Gateway startup/reload owns configured identities. Isolated read-only drafts may publish
      // separately, but stale drafts must never replace an overlapping configured generation.
      return undefined;
    }
    try {
      return await publishPreparedModelRuntimeSnapshot(
        {
          ...input,
          preserveWorkspaceDirOnRefresh: input.workspaceDir !== undefined,
        },
        { provenance: "standalone" },
      );
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimePublicationSupersededError)) {
        throw error;
      }
      const replacement = pendingModelRuntimeReplacement;
      if (replacement) {
        await replacement.promise;
      }
    }
  }
}

const preparedModelRuntimeLeaseContext = {
  owners,
  agentBuildCompletions,
  retainedDirectRunOwners,
  retainedGatewayRunOwners,
  getBuildTimeoutMs: () => modelRuntimeBuildTimeoutMs,
  getGatewayLifecycleActive: () => gatewayLifecycleActive,
  getPendingReplacement: () => pendingModelRuntimeReplacement,
  prepareSnapshot: prepareModelRuntimeSnapshot,
};

/** Acquires the exact writable workspace generation at agent-run admission. */
export async function acquireAgentRunPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
  options: {
    retainIdleRunOwner?: boolean;
    catalogMode?: PreparedModelRuntimeCatalogMode;
    pluginGeneration?: PreparedModelRuntimeOwner["pluginGeneration"];
  } = {},
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLeaseFromOwners(
    rawInput,
    "run",
    preparedModelRuntimeLeaseContext,
    options,
  );
}

/** Acquires an exact read-only generation scoped to the returned lease. */
export async function acquireReadOnlyPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLeaseFromOwners(
    { ...rawInput, readOnly: true },
    "ephemeral",
    preparedModelRuntimeLeaseContext,
  );
}

/** Returns the snapshot published by the lifecycle owner. Request config cannot replace it. */
export async function prepareModelRuntimeSnapshot(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeSnapshot> {
  const replacement = pendingModelRuntimeReplacement;
  if (replacement) {
    // Individual owners may finish before a multi-owner publication commits. The lifecycle gate
    // makes the generation visible atomically only after every owner and auth mutation is ready.
    await replacement.promise;
    return await prepareModelRuntimeSnapshot(rawInput);
  }
  const input = normalizePreparedModelRuntimeInput(rawInput);
  const existing = resolvePublishedOwner(owners, input, {
    allowConfiguredWorkspaceFallback:
      rawInput.workspaceDir === undefined ||
      rawInput.agentId === undefined ||
      rawInput.runtimePluginSelections === undefined,
  });
  if (
    input.readOnly &&
    existing &&
    !preparedModelRuntimeConfigsMatch(existing.input.config, input.config)
  ) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      `prepared read-only model runtime owner was not published for the requested config (${input.agentDir})`,
    );
  }
  // Generated catalogs are lifecycle artifacts, not a live-edit surface. Config/plugin reload,
  // doctor/auth repair, and auth publication replace owners; external edits require restart.
  if (existing?.pending) {
    try {
      await existing.pending;
    } catch {
      // Re-read the owner below so a superseding generation wins over this result or error.
    }
    return await prepareModelRuntimeSnapshot(rawInput);
  }
  if (existing?.needsRefresh) {
    throw existing.refreshError ?? new Error("prepared model runtime refresh is pending");
  }
  if (existing?.snapshot) {
    return existing.snapshot;
  }
  throw new PreparedModelRuntimeOwnerNotPublishedError(
    `prepared model runtime owner was not published for ${input.agentDir}`,
  );
}

/** Invalidates every published generation before config/plugin runtime replacement. */
export function markPreparedModelRuntimeSnapshotsStale(
  reason = "prepared model runtime owner is stale after config publication",
  options: { waitForReplacement?: boolean; preserveReplacementWait?: boolean } = {},
): PreparedModelRuntimeReplacementGateId | undefined {
  replyDispatchPublication.clear();
  if (options.waitForReplacement) {
    const superseded = pendingModelRuntimeReplacement;
    pendingModelRuntimeReplacement = createPreparedModelRuntimeReplacement();
    // Superseded readers retry against the newer replacement gate.
    superseded?.resolve();
  } else if (!options.preserveReplacementWait && pendingModelRuntimeReplacement) {
    const cancelled = pendingModelRuntimeReplacement;
    pendingModelRuntimeReplacement = undefined;
    cancelled.resolve();
  }
  refreshRequestEpoch += 1;
  const staleError = new Error(reason);
  for (const [key, owner] of owners) {
    // Standalone owners have no publication controller to rebuild them. Retire them so the next
    // standalone lifecycle boundary can activate a fresh generation after publication changes.
    if (owner.provenance === "standalone") {
      owner.generation += 1;
      owners.delete(key);
      continue;
    }
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
    owner.pluginGeneration = undefined;
  }
  notifyPreparedModelRuntimePublication({ phase: "invalidated" });
  if (!pendingModelRuntimeReplacement) {
    notifyPreparedModelRuntimePublication({ phase: "failed", error: staleError });
  }
  return pendingModelRuntimeReplacement?.gateId;
}

/** Rejects readers waiting for a replacement when its owning reload cannot continue. */
export function rejectPendingPreparedModelRuntimeReplacement(
  gateId: PreparedModelRuntimeReplacementGateId | undefined,
  error: unknown,
): void {
  const replacement = pendingModelRuntimeReplacement;
  if (!replacement || !gateId || replacement.gateId !== gateId) {
    return;
  }
  pendingModelRuntimeReplacement = undefined;
  const replacementError = toStringifiedError(error);
  replacement.reject(replacementError);
  notifyPreparedModelRuntimePublication({ phase: "failed", error: replacementError });
}

/** Rebuilds active owners after config/plugin runtime publication. */
async function refreshPreparedModelRuntimeSnapshotsNow(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  publicationEpoch: number,
): Promise<void> {
  retainedGatewayRunOwners.clear(owners);
  const { defaultWorkspaceDir: workspace, allowGatewaySubagentBinding: bindings } = options;
  const catalogMode = options.catalogMode ?? "live";
  gatewayLifecycleActive ||= options.gatewayLifecycle === true;
  const staleError = new Error("prepared model runtime owner is stale after config publication");
  for (const owner of owners.values()) {
    // Invalidate every prior generation before starting any replacement. A failed reload must
    // never leave an old-config snapshot available beside partially published new owners.
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
  }
  const entries: Array<{ owner?: PreparedModelRuntimeOwner; input: PreparedModelRuntimeInput }> =
    [];
  const knownKeys = new Set<string>();
  for (const rawInput of listConfiguredOwnerInputs(config, workspace, bindings)) {
    let input = normalizePreparedModelRuntimeInput(rawInput);
    const preservedOwner = [...owners.values()].find(
      (owner) =>
        owner.provenance === "configured" &&
        owner.input.agentId === input.agentId &&
        owner.input.agentDir === input.agentDir &&
        owner.input.preserveWorkspaceDirOnRefresh &&
        owner.input.workspaceDir,
    );
    if (preservedOwner?.input.workspaceDir) {
      input = {
        ...input,
        workspaceDir: preservedOwner.input.workspaceDir,
        preserveWorkspaceDirOnRefresh: true,
      };
    }
    const key = ownerKey(input);
    if (knownKeys.has(key)) {
      continue;
    }
    knownKeys.add(key);
    const owner = owners.get(key);
    entries.push({ owner, input });
  }
  for (const [key, owner] of owners) {
    if (!knownKeys.has(key) && (gatewayLifecycleActive || owner.provenance === "configured")) {
      owners.delete(key);
    }
  }
  const candidates = entries.map(({ owner: existing, input }) => {
    // Dynamic and standalone owners have different lifetime contracts. A configured publication
    // must replace them so an older lease release cannot remove the committed generation.
    const owner =
      existing?.provenance === "configured"
        ? existing
        : createPreparedModelRuntimeOwner(input, "configured", catalogMode);
    owner.input = input;
    owner.environmentFingerprint = effectiveEnvironmentFingerprint(input);
    owner.catalogMode = catalogMode;
    owner.provenance = "configured";
    return { input, owner };
  });
  await publishPreparedModelRuntimeOwnerBatch({
    entries: candidates,
    owners,
    agentBuildCompletions,
    buildTimeoutMs: modelRuntimeBuildTimeoutMs,
    isPublicationCurrent: () => publicationEpoch === refreshRequestEpoch,
    // Config replacement is one transaction. Per-owner auth supersession may retire individual
    // candidates, while a newer config epoch stops every remaining build in this publication.
    isBuildCurrent: () => publicationEpoch === refreshRequestEpoch,
    onBuildStats: options.onBuildStats,
    pluginMetadataSnapshot: options.pluginMetadataSnapshot,
    registerEntriesAfterBuildStart: true,
  });
}

/** Serializes config/plugin publications so only the latest completed refresh retires owners. */
export function refreshPreparedModelRuntimeSnapshots(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions = {},
): Promise<void> {
  // Stale synchronously. Queued publication must never leave the prior generation request-visible.
  markPreparedModelRuntimeSnapshotsStale(undefined, { waitForReplacement: true });
  const requestEpoch = refreshRequestEpoch;
  const replacement = pendingModelRuntimeReplacement;
  return enqueuePreparedModelRuntimePublication(async () => {
    if (requestEpoch !== refreshRequestEpoch) {
      return;
    }
    await refreshPreparedModelRuntimeSnapshotsNow(config, options, requestEpoch);
    if (requestEpoch !== refreshRequestEpoch) {
      return;
    }
    await drainPendingAuthMutations();
    if (requestEpoch !== refreshRequestEpoch) {
      return;
    }
    replyDispatchPublication.rebuild(owners.values());
  }).then(
    () => {
      if (
        requestEpoch === refreshRequestEpoch &&
        replacement &&
        pendingModelRuntimeReplacement === replacement
      ) {
        pendingModelRuntimeReplacement = undefined;
        replacement.resolve();
        // Publication listeners may synchronously read the committed owner. Clear the lifecycle
        // gate before announcing availability so they cannot observe a false missing generation.
        notifyPreparedModelRuntimePublication({ phase: "published" });
      }
    },
    (error: unknown) => {
      const refreshError = toStringifiedError(error);
      if (requestEpoch === refreshRequestEpoch) {
        // Candidate and queued auth builds may finish independently. A failed transaction must
        // leave no owner from its partially published generation request-visible.
        for (const owner of owners.values()) {
          owner.generation += 1;
          owner.pending = undefined;
          owner.needsRefresh = true;
          owner.refreshError = refreshError;
          owner.pluginGeneration = undefined;
        }
      }
      if (
        requestEpoch === refreshRequestEpoch &&
        replacement &&
        pendingModelRuntimeReplacement === replacement
      ) {
        pendingModelRuntimeReplacement = undefined;
        replacement.reject(refreshError);
        notifyPreparedModelRuntimePublication({ phase: "failed", error: refreshError });
      }
      throw refreshError;
    },
  );
}

function enqueuePreparedModelRuntimePublication(task: () => Promise<void>): Promise<void> {
  const publication = refreshTail.then(task);
  refreshTail = publication.then(
    () => undefined,
    () => undefined,
  );
  return publication;
}

async function drainPendingAuthMutations(): Promise<void> {
  while (pendingAuthMutations.length > 0) {
    const events = pendingAuthMutations.splice(0);
    for (const event of events) {
      event.agentDir = normalizeOptionalDir(event.agentDir);
    }
    const entries: Array<{
      owner: PreparedModelRuntimeOwner;
      input: PreparedModelRuntimeInput;
    }> = [];
    for (const owner of owners.values()) {
      const affected = events.some(
        (event) =>
          event.affectsInheritedStores ||
          owner.input.agentDir === event.agentDir ||
          owner.input.inheritedAuthDir === event.agentDir,
      );
      if (affected) {
        entries.push({ owner, input: owner.input });
      }
    }
    await publishPreparedModelRuntimeOwnerBatch({
      entries,
      owners,
      agentBuildCompletions,
      buildTimeoutMs: modelRuntimeBuildTimeoutMs,
      reusePluginGenerations: true,
    });
  }
}

function invalidateForAuthMutation(event: AuthMutationEvent): void {
  const normalizedEvent = {
    ...event,
    agentDir: normalizeOptionalDir(event.agentDir),
  };
  const staleError = new Error("prepared model runtime owner is stale after auth mutation");
  let invalidatedOwner = false;
  const invalidatedConfiguredAgentIds = new Set<string>();
  for (const owner of owners.values()) {
    if (
      !normalizedEvent.affectsInheritedStores &&
      owner.input.agentDir !== normalizedEvent.agentDir &&
      owner.input.inheritedAuthDir !== normalizedEvent.agentDir
    ) {
      continue;
    }
    invalidatedOwner = true;
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
    if (owner.provenance === "configured" && owner.input.agentId) {
      invalidatedConfiguredAgentIds.add(owner.input.agentId);
    }
  }
  if (!invalidatedOwner) {
    // A first owner reads the already-published auth snapshot while it builds. Replaying an earlier
    // mutation would immediately stale that initial generation even though no prior owner existed.
    return;
  }
  replyDispatchPublication.remove(invalidatedConfiguredAgentIds);
  notifyPreparedModelRuntimePublication({ phase: "invalidated" });
  pendingAuthMutations.push(normalizedEvent);
  void enqueuePreparedModelRuntimePublication(async () => {
    // A pending replacement gate means a queued config publication owns the next generation:
    // it drains queued auth mutations against the new config and rebuilds/announces the
    // dispatch publication. Rebuilding here would revive stale owners with the old config or
    // throw on them, emitting a spurious failed/published event that wedges chat metadata.
    if (pendingModelRuntimeReplacement) {
      return;
    }
    await drainPendingAuthMutations();
    if (pendingModelRuntimeReplacement) {
      return;
    }
    replyDispatchPublication.rebuild(owners.values());
    notifyPreparedModelRuntimePublication({ phase: "published" });
  }).catch((error: unknown) => {
    if (error instanceof PreparedModelRuntimePublicationSupersededError) {
      return;
    }
    const refreshError = toStringifiedError(error);
    notifyPreparedModelRuntimePublication({ phase: "failed", error: refreshError });
    log.warn(`auth-triggered model runtime refresh failed: ${String(refreshError)}`);
  });
}

registerRuntimeAuthProfileStoreMutationListener(invalidateForAuthMutation);
registerPreparedRuntimeAuthMaterializationPublisher(owners, notifyPreparedModelRuntimePublication);

function resetPreparedModelRuntimeSnapshotsForTest(): void {
  pendingModelRuntimeReplacement?.resolve();
  pendingModelRuntimeReplacement = undefined;
  owners.clear();
  agentBuildCompletions.clear();
  standaloneActivationTails.clear();
  retainedGatewayRunOwners.clear(owners);
  gatewayLifecycleActive = false;
  refreshTail = Promise.resolve();
  refreshRequestEpoch = 0;
  pendingAuthMutations.length = 0;
  replyDispatchPublication.clear();
  resetPreparedModelRuntimePublicationListenersForTest();
  modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.preparedModelRuntimeTestApi")] =
    {
      resetPreparedModelRuntimeSnapshotsForTest,
      getPreparedModelRuntimeOwnerCountForTest: () => owners.size,
      setModelRuntimeBuildTimeoutMsForTest: (timeoutMs: number) => {
        modelRuntimeBuildTimeoutMs = timeoutMs;
      },
    };
}
