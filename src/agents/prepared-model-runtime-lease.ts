/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { getPreparedModelRuntimeBorrowedSnapshot } from "./prepared-model-runtime-generation-scope.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  hasConfiguredOwnerMatching,
  ownerKey,
  normalizePreparedModelRuntimeInput,
  preparedModelRuntimeConfigsMatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  resolveConfiguredOwner,
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

/**
 * A gateway generation can only supply dynamic provider models for plugin owners it actually
 * loaded. Model ids do not matter to that ownership boundary: the registry is selected by the
 * normalized provider/runtime pair (for example `openai` + `codex`).
 */
function runtimePluginSelectionsAreCovered(
  available: PreparedModelRuntimeInput["runtimePluginSelections"],
  requested: PreparedModelRuntimeInput["runtimePluginSelections"],
): boolean {
  const availableOwners = new Set(
    (available ?? []).map(({ provider, runtime }) => JSON.stringify([provider, runtime])),
  );
  return (requested ?? []).every(({ provider, runtime }) =>
    availableOwners.has(JSON.stringify([provider, runtime])),
  );
}

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
  // Keep the admitted generation separate from the reusable generation. A selected route can
  // require a provider/runtime owner outside the configured primary's registry; it must build a
  // fresh registry from the same immutable metadata snapshot. The admitted generation still
  // guards reload staleness below.
  const admittedPluginGeneration = options.pluginGeneration;
  let reusablePluginGeneration = admittedPluginGeneration;
  let normalizedInput = normalizePreparedModelRuntimeInput({
    ...rawInput,
    preserveWorkspaceDirOnRefresh:
      rawInput.preserveWorkspaceDirOnRefresh ?? rawInput.workspaceDir !== undefined,
  });
  if (
    provenance === "run" &&
    context.getGatewayLifecycleActive() &&
    !admittedPluginGeneration &&
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
    let selectedRouteRequiresFreshRegistry = false;
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = context.getPendingReplacement();
    if (replacement) {
      await replacement.promise;
      if (context.getPendingReplacement()) {
        continue;
      }
      if (provenance === "run" && !admittedPluginGeneration) {
        input = rebindInputToCommittedConfiguredOwner(context.owners, input);
        key = ownerKey(input);
      }
      continue;
    }
    if (provenance === "run" && context.getGatewayLifecycleActive() && admittedPluginGeneration) {
      const configuredOwner = resolveConfiguredOwner(context.owners, input);
      if (configuredOwner?.pending) {
        await configuredOwner.pending.catch(() => undefined);
        continue;
      }
      if (
        configuredOwner &&
        (configuredOwner.needsRefresh ||
          configuredOwner.pluginGeneration !== admittedPluginGeneration)
      ) {
        const borrowed = getPreparedModelRuntimeBorrowedSnapshot(admittedPluginGeneration);
        if (
          !configuredOwner.needsRefresh &&
          borrowed &&
          borrowed.metadataSnapshot === admittedPluginGeneration.pluginMetadataSnapshot &&
          preparedModelRuntimeConfigsMatch(borrowed.config, input.config) &&
          borrowed.agentId === input.agentId &&
          borrowed.agentDir === input.agentDir &&
          borrowed.inheritedAuthDir === input.inheritedAuthDir &&
          borrowed.workspaceDir === input.workspaceDir &&
          (!input.allowGatewaySubagentBinding || borrowed.allowGatewaySubagentBinding) &&
          !input.readOnly &&
          !input.loadRuntimePlugins &&
          !input.skipCredentials &&
          !input.env
        ) {
          // A turn may finish under its still-open parent lease after reload. Its historic
          // generation must never publish over the configured owner for newly admitted work.
          return { snapshot: borrowed, release: () => {} };
        }
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
        );
      }
      if (
        configuredOwner &&
        !runtimePluginSelectionsAreCovered(
          configuredOwner.input.runtimePluginSelections,
          input.runtimePluginSelections,
        )
      ) {
        // Preserve the exact metadata generation admitted by the gateway, but do not reuse its
        // registry when the selected route needs another provider/runtime owner.
        reusablePluginGeneration = undefined;
        selectedRouteRequiresFreshRegistry = true;
      }
    }
    let existing = context.owners.get(key);
    let staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
    const pluginGenerationChanged =
      !selectedRouteRequiresFreshRegistry &&
      admittedPluginGeneration !== undefined &&
      (existing?.pending ? existing.pendingPluginGeneration : existing?.pluginGeneration) !==
        admittedPluginGeneration;
    const reusablePluginMetadataSnapshot = selectedRouteRequiresFreshRegistry
      ? admittedPluginGeneration?.pluginMetadataSnapshot
      : options.pluginMetadataSnapshot;
    if (existing?.pending && pluginGenerationChanged) {
      // Do not supersede active discovery. Wait for its owner to settle, then retry against
      // the published identity so same-generation callers still coalesce.
      await existing.pending.catch(() => undefined);
      continue;
    }
    if (
      context.getGatewayLifecycleActive() &&
      provenance === "run" &&
      !admittedPluginGeneration &&
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
          reusablePluginGeneration,
          reusablePluginMetadataSnapshot,
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
