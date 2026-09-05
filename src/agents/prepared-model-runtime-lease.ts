/** Agent-run lease admission for lifecycle-owned prepared model runtimes. */
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { getPreparedModelRuntimeBorrowedSnapshot } from "./prepared-model-runtime-generation-scope.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
  ownerKey,
  normalizePreparedModelRuntimeInput,
  preparedModelRuntimeConfigsMatch,
  publishModelRuntimeSnapshot,
  rebindInputToCommittedConfiguredOwner,
  retirePreparedModelRuntimeOwnerIfUnused,
  resolveConfiguredOwner,
  resolveConfiguredOwnerPublication,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
  type PreparedModelRuntimeOwner,
  type PreparedModelRuntimeOwnerRetention,
  type PreparedModelRuntimeReplacement,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.owner.js";
import {
  preparedPluginGenerationReusesBase,
  preparedPluginGenerationSupportsSelections,
} from "./prepared-model-runtime.plugin-generation.js";
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

function throwIfLeaseAdmissionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError("Prepared model runtime lease admission aborted", {
      cause: signal.reason,
    });
  }
}

function createPreparedModelRuntimeAdmissionClaim(context: PreparedModelRuntimeLeaseContext) {
  let claimed: { key: string; owner: PreparedModelRuntimeOwner } | undefined;
  const release = () => {
    if (!claimed) {
      return;
    }
    const { key, owner } = claimed;
    claimed = undefined;
    owner.admissionCount = Math.max(0, (owner.admissionCount ?? 1) - 1);
    retirePreparedModelRuntimeOwnerIfUnused(
      context.owners,
      key,
      owner,
      context.retainedDirectRunOwners.has(key, owner) ||
        context.retainedGatewayRunOwners.has(key, owner),
    );
  };
  return {
    claim: (key: string, owner: PreparedModelRuntimeOwner) => {
      if (claimed?.key === key && claimed.owner === owner) {
        return;
      }
      release();
      if (
        (owner.provenance !== "run" && owner.provenance !== "ephemeral") ||
        context.owners.get(key) !== owner
      ) {
        return;
      }
      owner.admissionCount = (owner.admissionCount ?? 0) + 1;
      claimed = { key, owner };
    },
    release,
  };
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
    abortSignal?: AbortSignal;
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
  const admission = createPreparedModelRuntimeAdmissionClaim(context);
  for (;;) {
    admission.release();
    throwIfLeaseAdmissionAborted(options.abortSignal);
    // Replacement owns publication from synchronous staling through atomic generation commit.
    // Dynamic work arriving inside that window must retry after the new owners become visible.
    const replacement = context.getPendingReplacement();
    if (replacement) {
      await racePromiseWithAbortSignal(replacement.promise, options.abortSignal);
      if (context.getPendingReplacement()) {
        continue;
      }
      if (provenance === "run" && !options.pluginGeneration) {
        input = rebindInputToCommittedConfiguredOwner(context.owners, input);
        key = ownerKey(input);
      }
      continue;
    }
    if (provenance === "run" && context.getGatewayLifecycleActive() && options.pluginGeneration) {
      const configuredOwner = resolveConfiguredOwner(context.owners, input);
      if (configuredOwner?.pending) {
        await racePromiseWithAbortSignal(
          configuredOwner.pending.catch(() => undefined),
          options.abortSignal,
        );
        continue;
      }
      if (
        configuredOwner &&
        (configuredOwner.needsRefresh ||
          configuredOwner.pluginGeneration !== options.pluginGeneration)
      ) {
        const borrowed = getPreparedModelRuntimeBorrowedSnapshot(options.pluginGeneration);
        if (
          !configuredOwner.needsRefresh &&
          borrowed &&
          borrowed.metadataSnapshot === options.pluginGeneration.pluginMetadataSnapshot &&
          preparedModelRuntimeConfigsMatch(borrowed.config, input.config) &&
          borrowed.agentId === input.agentId &&
          borrowed.agentDir === input.agentDir &&
          borrowed.inheritedAuthDir === input.inheritedAuthDir &&
          borrowed.workspaceDir === input.workspaceDir &&
          (!input.allowGatewaySubagentBinding || borrowed.allowGatewaySubagentBinding) &&
          !input.readOnly &&
          !input.loadRuntimePlugins &&
          !input.skipCredentials &&
          !input.env &&
          preparedPluginGenerationSupportsSelections(options.pluginGeneration, input)
        ) {
          // A turn may finish under its still-open parent lease after reload. Its historic
          // generation must never publish over the configured owner for newly admitted work.
          throwIfLeaseAdmissionAborted(options.abortSignal);
          return {
            snapshot: borrowed,
            pluginGeneration: options.pluginGeneration,
            release: () => {},
          };
        }
        throw new PreparedModelRuntimeOwnerNotPublishedError(
          `prepared model runtime plugin generation was superseded for ${input.agentDir}`,
        );
      }
    }
    let existing = context.owners.get(key);
    let staleDynamicOwner =
      existing?.needsRefresh &&
      !existing.pending &&
      (existing.provenance === "run" || existing.provenance === "ephemeral");
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
        const configuredOwner = resolveConfiguredOwnerPublication(context.owners, input);
        if (configuredOwner.matches || !canActivateConfiglessSetup) {
          const pending = configuredOwner.pending;
          if (pending) {
            await racePromiseWithAbortSignal(pending, options.abortSignal);
            continue;
          }
          throw error;
        }
        // First-run Model Setup uses the reserved system-agent identity before a configless gateway
        // has an owner to rebind. Keep ordinary agent runs fail-closed at this ownership boundary.
      }
    }
    // A static owner cannot satisfy explicit live discovery; publish a new exact generation.
    const ownerGenerationChanged =
      (options.pluginGeneration !== undefined &&
        !preparedPluginGenerationReusesBase(
          existing?.pending ? existing.pendingPluginGeneration : existing?.pluginGeneration,
          options.pluginGeneration,
        )) ||
      (options.catalogMode === "live" && existing?.catalogMode === "static");
    if (existing?.pending && ownerGenerationChanged) {
      // Do not supersede active discovery. Wait for its owner to settle, then retry against
      // the published identity so same-generation callers still coalesce.
      await racePromiseWithAbortSignal(
        existing.pending.catch(() => undefined),
        options.abortSignal,
      );
      continue;
    }
    try {
      if (existing?.pending && !ownerGenerationChanged) {
        // Matching callers lease the immutable generation they joined even if a queued
        // mismatched caller publishes the next owner immediately after this one settles.
        admission.claim(key, existing);
        snapshot = await racePromiseWithAbortSignal(existing.pending, options.abortSignal);
        if (existing.snapshot !== snapshot || existing.needsRefresh) {
          continue;
        }
        owner = existing;
        break;
      }
      if (existing && !staleDynamicOwner && !ownerGenerationChanged) {
        admission.claim(key, existing);
        snapshot = await racePromiseWithAbortSignal(
          context.prepareSnapshot(input),
          options.abortSignal,
        );
      } else {
        // Fresh keys publish a first generation; stale dynamic owners publish a distinct
        // replacement owner because existing leases retain their immutable snapshot, so
        // their release cannot delete the generation admitted for new work at this key.
        const publication = publishModelRuntimeSnapshot(
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
        // Publication installs its exact owner synchronously before exposing the pending promise.
        const publishingOwner = context.owners.get(key);
        if (publishingOwner) {
          admission.claim(key, publishingOwner);
        }
        snapshot = await racePromiseWithAbortSignal(publication, options.abortSignal);
      }
    } catch (error) {
      admission.release();
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
    admission.claim(key, published);
    owner = published;
    break;
  }
  try {
    throwIfLeaseAdmissionAborted(options.abortSignal);
    const pluginGeneration = owner.pluginGeneration!;
    if (owner.provenance !== provenance) {
      return { snapshot, pluginGeneration, release: () => {} };
    }
    throwIfLeaseAdmissionAborted(options.abortSignal);
    if (provenance === "run" && options.retainIdleRunOwner) {
      context.retainedDirectRunOwners.retain(key, owner, context.owners);
    } else if (provenance === "run" && context.getGatewayLifecycleActive()) {
      context.retainedGatewayRunOwners.retain(key, owner, context.owners);
    }
    owner.leaseCount = (owner.leaseCount ?? 0) + 1;
    admission.release();
    let released = false;
    return {
      snapshot,
      pluginGeneration,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        owner.leaseCount = Math.max(0, (owner.leaseCount ?? 1) - 1);
        // Direct runs retain one idle generation; gateways retain a bounded LRU so repeated selections
        // reuse workspace facts. Identity checks keep old releases from deleting replacements.
        retirePreparedModelRuntimeOwnerIfUnused(
          context.owners,
          key,
          owner,
          context.retainedDirectRunOwners.has(key, owner) ||
            context.retainedGatewayRunOwners.has(key, owner),
        );
      },
    };
  } finally {
    admission.release();
  }
}
