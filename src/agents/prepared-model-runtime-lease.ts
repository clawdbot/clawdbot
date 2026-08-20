/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
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
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import type { PreparedModelRuntimeCatalogMode } from "./prepared-model-runtime.types.js";

type PreparedModelRuntimeLeaseContext = {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  retainedDirectRunOwners: PreparedModelRuntimeOwnerRetention;
  retainedGatewayRunOwners: PreparedModelRuntimeOwnerRetention;
  getBuildTimeoutMs(): number;
  getGatewayLifecycleActive(): boolean;
  getPendingReplacement(): PreparedModelRuntimeReplacement | undefined;
  prepareSnapshot(input: PreparedModelRuntimeInput): Promise<PreparedModelRuntimeSnapshot>;
};

export async function acquirePreparedModelRuntimeLeaseFromOwners(
  rawInput: PreparedModelRuntimeInput,
  provenance: "run" | "ephemeral",
  context: PreparedModelRuntimeLeaseContext,
  options: {
    retainIdleRunOwner?: boolean;
    catalogMode?: PreparedModelRuntimeCatalogMode;
    pluginGeneration?: PreparedModelRuntimeOwner["pluginGeneration"];
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
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
    !options.pluginGeneration &&
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
  let input = normalizedInput;
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
      if (provenance === "run" && !options.pluginGeneration) {
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
    const pluginGenerationChanged =
      options.pluginGeneration !== undefined &&
      (existing?.pending ? existing.pendingPluginGeneration : existing?.pluginGeneration) !==
        options.pluginGeneration;
    if (existing?.pending && pluginGenerationChanged) {
      // Do not supersede active discovery. Wait for its owner to settle, then retry against
      // the published identity so same-generation callers still coalesce.
      await existing.pending.catch(() => undefined);
      continue;
    }
    if (
      context.getGatewayLifecycleActive() &&
      provenance === "run" &&
      !options.pluginGeneration &&
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
      if (existing?.pending && !pluginGenerationChanged) {
        // Matching callers lease the immutable generation they joined even if a queued
        // mismatched caller publishes the next owner immediately after this one settles.
        snapshot = await existing.pending;
        if (existing.snapshot !== snapshot || existing.needsRefresh) {
          continue;
        }
        owner = existing;
        break;
      }
      if (existing && !staleDynamicOwner && !pluginGenerationChanged) {
        snapshot = await context.prepareSnapshot(input);
      } else {
        // Fresh keys publish a first generation; stale dynamic owners publish a distinct
        // replacement owner because existing leases retain their immutable snapshot, so
        // their release cannot delete the generation admitted for new work at this key.
        snapshot = await publishModelRuntimeSnapshot(
          input,
          context.owners,
          context.agentBuildCompletions,
          context.getBuildTimeoutMs(),
          undefined,
          provenance,
          options.catalogMode,
          options.pluginGeneration,
          options.pluginMetadataSnapshot,
        );
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
