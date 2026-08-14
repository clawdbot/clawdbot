/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import fsp from "node:fs/promises";
import path from "node:path";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  hasConfiguredOwnerMatching,
  ownerKey,
  normalizePreparedModelRuntimeInput,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeOwnerRetention,
  type PreparedModelRuntimePublicationOptions,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import type { PreparedModelRuntimeCatalogMode } from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeLeaseContext = {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  workspacePluginRootPresenceResolutions: Map<string, Promise<boolean | undefined>>;
  retainedDirectRunOwners: PreparedModelRuntimeOwnerRetention;
  retainedGatewayRunOwners: PreparedModelRuntimeOwnerRetention;
  getBuildTimeoutMs(): number;
  getGatewayLifecycleActive(): boolean;
  getPendingReplacement(): PreparedModelRuntimeReplacement | undefined;
  prepareSnapshot(input: PreparedModelRuntimeInput): Promise<PreparedModelRuntimeSnapshot>;
  publishSnapshot(
    input: PreparedModelRuntimeInput,
    options: PreparedModelRuntimePublicationOptions,
  ): Promise<PreparedModelRuntimeSnapshot>;
};

async function resolveCoalescedWorkspacePluginRootPresence(
  input: PreparedModelRuntimeInput,
  context: PreparedModelRuntimeLeaseContext,
): Promise<boolean | undefined> {
  const key = ownerKey(input);
  const existing = context.workspacePluginRootPresenceResolutions.get(key);
  if (existing) {
    return await existing;
  }
  const pending = resolveWorkspacePluginRootPresence(input);
  context.workspacePluginRootPresenceResolutions.set(key, pending);
  try {
    return await pending;
  } finally {
    if (context.workspacePluginRootPresenceResolutions.get(key) === pending) {
      context.workspacePluginRootPresenceResolutions.delete(key);
    }
  }
}

export async function resolveWorkspacePluginRootPresence(
  input: PreparedModelRuntimeInput,
): Promise<boolean | undefined> {
  if (input.workspacePluginRootPresent !== undefined || !input.workspaceDir) {
    return input.workspacePluginRootPresent;
  }
  return await fsp
    .stat(path.join(input.workspaceDir, ".openclaw", "extensions"))
    .then(() => true)
    .catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return false;
      }
      throw error;
    });
}

export async function acquirePreparedModelRuntimeLeaseFromOwners(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: {
    retainIdleRunOwner?: boolean;
    catalogMode?: PreparedModelRuntimeCatalogMode;
  } = {},
): Promise<PreparedModelRuntimeLease> {
  let normalizedInput = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  if (
    provenance === "run" &&
    context.getGatewayLifecycleActive() &&
    !context.getPendingReplacement()
  ) {
    try {
      normalizedInput = rebindInputToCommittedConfiguredOwner(context.owners, normalizedInput);
    } catch (error) {
      if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
        throw error;
      }
    }
  }
  const retainedWorkspacePluginRootPresent = context.owners.get(ownerKey(normalizedInput))?.input
    .workspacePluginRootPresent;
  const workspacePluginRootPresent =
    rawInput.workspacePluginRootPresent ??
    retainedWorkspacePluginRootPresent ??
    (provenance === "run"
      ? await resolveCoalescedWorkspacePluginRootPresence(normalizedInput, context)
      : undefined);
  let input = normalizePreparedModelRuntimeInput({
    ...normalizedInput,
    ...(workspacePluginRootPresent === undefined ? {} : { workspacePluginRootPresent }),
  });
  let key = ownerKey(input);
  let owner: PreparedModelRuntimeOwner;
  let snapshot: PreparedModelRuntimeSnapshot;
  for (;;) {
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = context.getPendingReplacement();
    if (replacement) {
      await replacement.promise;
      if (context.getPendingReplacement()) {
        continue;
      }
      if (provenance === "run") {
        input = rebindInputToCommittedConfiguredOwner(context.owners, input);
        key = ownerKey(input);
      }
      continue;
    }
    let existing = context.owners.get(key);
    let staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
    if (
      context.getGatewayLifecycleActive() &&
      provenance === "run" &&
      (!existing || staleDynamicOwner)
    ) {
      // Dynamic workspaces still inherit the committed agent/config generation. Only their
      // explicitly pinned workspace may differ from the configured owner. A stale leased owner
      // can share this key, so rebase its input before publishing a replacement generation.
      try {
        input = rebindInputToCommittedConfiguredOwner(context.owners, input);
        key = ownerKey(input);
        existing = context.owners.get(key);
        staleDynamicOwner =
          existing?.needsRefresh &&
          !existing.pending &&
          (existing.provenance === "run" || existing.provenance === "ephemeral");
      } catch (error) {
        if (!(error instanceof PreparedModelRuntimeOwnerNotPublishedError)) {
          throw error;
        }
        const canActivateConfiglessSetup =
          input.agentId !== undefined && isReservedSystemAgentId(input.agentId);
        if (hasConfiguredOwnerMatching(context.owners, input) || !canActivateConfiglessSetup) {
          throw error;
        }
        // First-run Model Setup uses the reserved system-agent identity before a configless gateway
        // has an owner to rebind. Keep ordinary agent runs fail-closed at this ownership boundary.
      }
    }
    try {
      if (staleDynamicOwner) {
        // Existing leases retain their immutable snapshot. Publish a distinct owner so their release
        // cannot delete the replacement generation admitted for new work at the same dynamic key.
        snapshot = await publishModelRuntimeSnapshot(
          input,
          context.owners,
          context.agentBuildCompletions,
          context.getBuildTimeoutMs(),
          undefined,
          provenance,
          options.catalogMode,
        );
      } else if (existing) {
        snapshot = await context.prepareSnapshot(input);
      } else {
        snapshot = await context.publishSnapshot(input, {
          provenance,
          catalogMode: options.catalogMode,
        });
      }
    } catch (error) {
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        continue;
      }
      throw error;
    }
    const published = context.owners.get(key);
    if (
      context.getPendingReplacement() ||
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
    context.retainedDirectRunOwners.retain(key, owner, context.owners);
  } else if (provenance === "run" && context.getGatewayLifecycleActive()) {
    context.retainedGatewayRunOwners.retain(key, owner, context.owners);
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
      // Direct runs retain one idle generation; gateways retain a bounded LRU so repeated selections
      // reuse workspace facts. Identity checks keep old releases from deleting replacements.
      if (owner.leaseCount === 0 && context.owners.get(key) === owner) {
        if (
          !context.retainedDirectRunOwners.has(key, owner) &&
          !context.retainedGatewayRunOwners.has(key, owner)
        ) {
          context.owners.delete(key);
        }
      }
    },
  };
}
