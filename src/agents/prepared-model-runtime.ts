/** Lifecycle-owned auth/model discovery snapshots for agent runs. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { registerRuntimeAuthProfileStoreMutationListener } from "./auth-profiles/runtime-snapshots.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  createPreparedModelRuntimeReplacement,
  effectiveEnvironmentFingerprint,
  hasSameLifecycleInput,
  listConfiguredOwnerInputs,
  normalizeOptionalDir,
  normalizePreparedModelRuntimeInput,
  ownerKey,
  preparedModelRuntimeConfigsMatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  resolvePublishedOwner,
  startSerializedSnapshotBuild,
  toError,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeReplacementGateId,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
export {
  PreparedModelRuntimeOwnerNotPublishedError,
  preparedModelRuntimeConfigsMatch,
} from "./prepared-model-runtime.owner.js";
export type { PreparedModelRuntimeReplacementGateId } from "./prepared-model-runtime.owner.js";
export type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeLease,
  PreparedModelRuntimeSnapshot,
  PreparedModelRuntimeStores,
} from "./prepared-model-runtime.owner.js";

const log = createSubsystemLogger("agents/prepared-model-runtime");
const DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS = 30_000;
let modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;

const owners = new Map<string, PreparedModelRuntimeOwner>();
const agentBuildCompletions = new Map<string, Promise<void>>();
const standaloneActivationTails = new Map<string, Promise<void>>();
let retainedDirectRunOwner: { key: string; owner: PreparedModelRuntimeOwner } | undefined;
let gatewayLifecycleActive = false;
let refreshTail: Promise<void> = Promise.resolve();
let refreshRequestEpoch = 0;
let pendingModelRuntimeReplacement: PreparedModelRuntimeReplacement | undefined;
type AuthMutationEvent = { agentDir?: string; affectsInheritedStores: boolean };
const pendingAuthMutations: AuthMutationEvent[] = [];

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
      rawInput.workspaceDir === undefined || rawInput.agentId === undefined,
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
  options: {
    force?: boolean;
    provenance?: PreparedModelRuntimeOwner["provenance"];
  } = {},
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

async function acquirePreparedModelRuntimeLease(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  options: { retainIdleRunOwner?: boolean } = {},
): Promise<PreparedModelRuntimeLease> {
  let input = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  let key = ownerKey(input);
  let owner: PreparedModelRuntimeOwner;
  let snapshot: PreparedModelRuntimeSnapshot;
  for (;;) {
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = pendingModelRuntimeReplacement;
    if (replacement) {
      await replacement.promise;
      if (pendingModelRuntimeReplacement) {
        continue;
      }
      input = rebindInputToCommittedConfiguredOwner(owners, input);
      key = ownerKey(input);
      continue;
    }
    let existing = owners.get(key);
    let staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
    if (gatewayLifecycleActive && provenance === "run" && (!existing || staleDynamicOwner)) {
      // Dynamic workspaces still inherit the committed agent/config generation. Only their
      // explicitly pinned workspace may differ from the configured owner. A stale leased owner
      // can share this key, so rebase its input before publishing a replacement generation.
      input = rebindInputToCommittedConfiguredOwner(owners, input);
      key = ownerKey(input);
      existing = owners.get(key);
      staleDynamicOwner =
        existing?.needsRefresh &&
        !existing.pending &&
        (existing.provenance === "run" || existing.provenance === "ephemeral");
    }
    try {
      if (staleDynamicOwner) {
        // Existing leases retain their immutable snapshot. Publish a distinct owner so their release
        // cannot delete the replacement generation admitted for new work at the same dynamic key.
        snapshot = await publishModelRuntimeSnapshot(
          input,
          owners,
          agentBuildCompletions,
          modelRuntimeBuildTimeoutMs,
          undefined,
          provenance,
        );
      } else if (existing) {
        snapshot = await prepareModelRuntimeSnapshot(input);
      } else {
        snapshot = await publishPreparedModelRuntimeSnapshot(input, { provenance });
      }
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        continue;
      }
      throw error;
    }
    const published = owners.get(key);
    if (
      pendingModelRuntimeReplacement ||
      !published ||
      published.snapshot !== snapshot ||
      published.needsRefresh ||
      published.pending
    ) {
      continue;
    }
    owner = published;
    break;
  }
  if (owner.provenance !== provenance) {
    return { snapshot, release: () => {} };
  }
  if (provenance === "run" && options.retainIdleRunOwner) {
    const previous = retainedDirectRunOwner;
    retainedDirectRunOwner = { key, owner };
    if (
      previous &&
      previous.owner !== owner &&
      (previous.owner.leaseCount ?? 0) === 0 &&
      owners.get(previous.key) === previous.owner
    ) {
      owners.delete(previous.key);
    }
  }
  owner.leaseCount = (owner.leaseCount ?? 0) + 1;
  let released = false;
  return {
    snapshot,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      owner.leaseCount = Math.max(0, (owner.leaseCount ?? 1) - 1);
      // Configless direct runs retain one bounded idle generation; dynamic gateway and metadata
      // generations live exactly as long as their lease. The identity checks prevent an old
      // release from deleting a replacement at the same key.
      if (owner.leaseCount === 0 && owners.get(key) === owner) {
        if (retainedDirectRunOwner?.owner !== owner) {
          owners.delete(key);
        }
      }
    },
  };
}

/** Acquires the exact writable workspace generation at agent-run admission. */
export async function acquireAgentRunPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
  options: { retainIdleRunOwner?: boolean } = {},
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLease(rawInput, "run", options);
}

/** Acquires a one-read metadata generation without retaining a dynamic workspace owner. */
export async function acquireReadOnlyPreparedModelRuntime(
  rawInput: PreparedModelRuntimeInput,
): Promise<PreparedModelRuntimeLease> {
  return await acquirePreparedModelRuntimeLease({ ...rawInput, readOnly: true }, "ephemeral");
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
      rawInput.workspaceDir === undefined || rawInput.agentId === undefined,
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
  replacement.reject(toError(error));
}

/** Rebuilds active owners after config/plugin runtime publication. */
async function refreshPreparedModelRuntimeSnapshotsNow(
  config: OpenClawConfig,
  options: { gatewayLifecycle?: boolean; defaultWorkspaceDir?: string } = {},
): Promise<void> {
  if (options.gatewayLifecycle) {
    gatewayLifecycleActive = true;
  }
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
  for (const rawInput of listConfiguredOwnerInputs(config, options.defaultWorkspaceDir)) {
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
    const owner: PreparedModelRuntimeOwner =
      existing?.provenance === "configured"
        ? existing
        : {
            input,
            environmentFingerprint: effectiveEnvironmentFingerprint(input),
            provenance: "configured",
            generation: 0,
            needsRefresh: true,
          };
    owner.input = input;
    owner.environmentFingerprint = effectiveEnvironmentFingerprint(input);
    owner.provenance = "configured";
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = undefined;
    const generation = owner.generation;
    const build = startSerializedSnapshotBuild(
      input,
      agentBuildCompletions,
      modelRuntimeBuildTimeoutMs,
    );
    owner.buildCompletion = build.completion;
    owners.set(ownerKey(input), owner);
    void build.completion.then(() => {
      if (owner.buildCompletion === build.completion) {
        owner.buildCompletion = undefined;
      }
    });
    return { build, generation, owner };
  });
  const publication = (async () => {
    try {
      const snapshots = await Promise.all(candidates.map(({ build }) => build.pending));
      for (const [index, candidate] of candidates.entries()) {
        if (candidate.owner.generation !== candidate.generation) {
          continue;
        }
        candidate.owner.snapshot = snapshots[index]!;
        candidate.owner.pending = undefined;
        candidate.owner.needsRefresh = false;
      }
      return snapshots;
    } catch (error) {
      const refreshError = toError(error);
      await Promise.allSettled(candidates.map(({ build }) => build.pending));
      for (const candidate of candidates) {
        if (candidate.owner.generation !== candidate.generation) {
          continue;
        }
        candidate.owner.pending = undefined;
        candidate.owner.needsRefresh = true;
        candidate.owner.refreshError = refreshError;
      }
      throw refreshError;
    }
  })();
  for (const [index, candidate] of candidates.entries()) {
    const pending = publication.then((snapshots) => snapshots[index]!);
    candidate.owner.pending = pending;
    void pending.catch(() => undefined);
  }
  await publication;
}

/** Serializes config/plugin publications so only the latest completed refresh retires owners. */
export function refreshPreparedModelRuntimeSnapshots(
  config: OpenClawConfig,
  options: { gatewayLifecycle?: boolean; defaultWorkspaceDir?: string } = {},
): Promise<void> {
  // Stale synchronously. Queued publication must never leave the prior generation request-visible.
  markPreparedModelRuntimeSnapshotsStale(undefined, { waitForReplacement: true });
  const requestEpoch = refreshRequestEpoch;
  const replacement = pendingModelRuntimeReplacement;
  const publication = enqueuePreparedModelRuntimePublication(async () => {
    if (requestEpoch !== refreshRequestEpoch) {
      return;
    }
    await refreshPreparedModelRuntimeSnapshotsNow(config, options);
    if (requestEpoch !== refreshRequestEpoch) {
      return;
    }
    await drainPendingAuthMutations();
  });
  return publication.then(
    () => {
      if (
        requestEpoch === refreshRequestEpoch &&
        replacement &&
        pendingModelRuntimeReplacement === replacement
      ) {
        pendingModelRuntimeReplacement = undefined;
        replacement.resolve();
      }
    },
    (error: unknown) => {
      const refreshError = toError(error);
      if (requestEpoch === refreshRequestEpoch) {
        // Candidate and queued auth builds may finish independently. A failed transaction must
        // leave no owner from its partially published generation request-visible.
        for (const owner of owners.values()) {
          owner.generation += 1;
          owner.pending = undefined;
          owner.needsRefresh = true;
          owner.refreshError = refreshError;
        }
      }
      if (
        requestEpoch === refreshRequestEpoch &&
        replacement &&
        pendingModelRuntimeReplacement === replacement
      ) {
        pendingModelRuntimeReplacement = undefined;
        replacement.reject(refreshError);
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
    await Promise.all(
      entries.map(
        async ({ owner, input }) =>
          await publishPreparedModelRuntimeSnapshot(input, {
            force: true,
            provenance: owner.provenance,
          }),
      ),
    );
  }
}

function invalidateForAuthMutation(event: AuthMutationEvent): void {
  const normalizedEvent = {
    ...event,
    agentDir: normalizeOptionalDir(event.agentDir),
  };
  const staleError = new Error("prepared model runtime owner is stale after auth mutation");
  for (const owner of owners.values()) {
    if (
      !normalizedEvent.affectsInheritedStores &&
      owner.input.agentDir !== normalizedEvent.agentDir &&
      owner.input.inheritedAuthDir !== normalizedEvent.agentDir
    ) {
      continue;
    }
    owner.generation += 1;
    owner.needsRefresh = true;
    owner.refreshError = staleError;
  }
  pendingAuthMutations.push(normalizedEvent);
  void enqueuePreparedModelRuntimePublication(drainPendingAuthMutations).catch((error: unknown) => {
    log.warn(`auth-triggered model runtime refresh failed: ${String(error)}`);
  });
}

registerRuntimeAuthProfileStoreMutationListener(invalidateForAuthMutation);

function resetPreparedModelRuntimeSnapshotsForTest(): void {
  pendingModelRuntimeReplacement?.resolve();
  pendingModelRuntimeReplacement = undefined;
  owners.clear();
  agentBuildCompletions.clear();
  standaloneActivationTails.clear();
  retainedDirectRunOwner = undefined;
  gatewayLifecycleActive = false;
  refreshTail = Promise.resolve();
  refreshRequestEpoch = 0;
  pendingAuthMutations.length = 0;
  modelRuntimeBuildTimeoutMs = DEFAULT_MODEL_RUNTIME_BUILD_TIMEOUT_MS;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.preparedModelRuntimeTestApi")] =
    {
      resetPreparedModelRuntimeSnapshotsForTest,
      setModelRuntimeBuildTimeoutMsForTest: (timeoutMs: number) => {
        modelRuntimeBuildTimeoutMs = timeoutMs;
      },
    };
}
