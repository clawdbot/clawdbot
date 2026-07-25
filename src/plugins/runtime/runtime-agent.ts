// Runtime agent helpers resolve agent-scoped directories and config for plugin execution.
import { isDeepStrictEqual } from "node:util";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveEmbeddedCliBackendDispatchEligibility } from "../../agents/embedded-agent-runner/cli-backend-dispatch-eligibility.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import {
  buildConfiguredModelCatalog,
  resolveThinkingDefault,
} from "../../agents/model-selection.js";
import {
  concretizeAgentRuntime,
  resolveEffectiveAgentRuntime,
} from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { normalizeThinkLevel, resolveThinkingProfile } from "../../auto-reply/thinking.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  listSessionEntries as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  patchSessionEntry as patchAccessorSessionEntry,
  replaceSessionEntry,
  rollbackAgentHarnessSessionEntryLifecycle,
  rollbackPluginOwnedSessionEntryLifecycle,
  type SessionAccessScope,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { normalizeResolvedMaintenanceConfigInput } from "../../config/sessions/store-maintenance.js";
import type { ResolvedSessionMaintenanceConfigInput } from "../../config/sessions/store-maintenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { resolveRuntimeThinkingCatalog } from "./runtime-agent-thinking.js";
import { defineCachedValue } from "./runtime-cache.js";
import type { PluginRuntime } from "./types.js";

type RuntimeSessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  sessionKey: string;
  readConsistency?: "latest";
  storePath?: string;
};

type RuntimeSessionStoreListParams = Partial<Omit<RuntimeSessionStoreReadParams, "sessionKey">> & {
  readOnly?: boolean;
};

type RuntimeSessionStoreEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

type RuntimeSessionStoreEntryUpdateParams = {
  storePath: string;
  sessionKey: string;
  update: (
    entry: SessionEntry,
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
};

type RuntimeSessionStoreEntryPatchParams = RuntimeSessionStoreReadParams & {
  fallbackEntry?: SessionEntry;
  maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
  preserveActivity?: boolean;
  replaceEntry?: boolean;
  update: (
    entry: SessionEntry,
    context: { existingEntry?: SessionEntry },
  ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
};

type RuntimeUpsertSessionEntryParams = RuntimeSessionStoreReadParams & {
  entry: SessionEntry;
};

const loadEmbeddedAgentRuntime = createLazyRuntimeModule(
  () => import("./runtime-embedded-agent.runtime.js"),
);

function toSessionAccessScope(params: RuntimeSessionStoreReadParams): SessionAccessScope {
  // Keep plugin runtime parameters aligned with the public SDK wrapper while
  // avoiding direct exposure of internal accessor-only options.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

function getSessionEntry(params: RuntimeSessionStoreReadParams): SessionEntry | undefined {
  return loadSessionEntryReadOnly(toSessionAccessScope(params));
}

function listSessionEntries(
  params: RuntimeSessionStoreListParams = {},
): RuntimeSessionStoreEntrySummary[] {
  const listEntries = params.readOnly
    ? listAccessorSessionEntriesReadOnly
    : listAccessorSessionEntries;
  return listEntries({
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  });
}

async function patchSessionEntry(
  params: RuntimeSessionStoreEntryPatchParams,
): Promise<SessionEntry | null> {
  return await patchAccessorSessionEntry(toSessionAccessScope(params), params.update, {
    fallbackEntry: params.fallbackEntry,
    maintenanceConfig:
      params.maintenanceConfig !== undefined
        ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
        : undefined,
    preserveActivity: params.preserveActivity,
    replaceEntry: params.replaceEntry,
  });
}

async function updateSessionStoreEntry(
  params: RuntimeSessionStoreEntryUpdateParams,
): Promise<SessionEntry | null> {
  // Maintainer note: keep the legacy object-parameter API here, but route
  // mutations through the session accessor boundary.
  return await updateSessionEntry(
    {
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.update,
    {
      skipMaintenance: params.skipMaintenance,
      takeCacheOwnership: params.takeCacheOwnership,
      requireWriteSuccess: params.requireWriteSuccess,
    },
  );
}

async function upsertSessionEntry(params: RuntimeUpsertSessionEntryParams): Promise<void> {
  // Maintainer note: this compatibility helper has full-entry replacement
  // semantics, so removed fields must not survive as merge leftovers.
  await replaceSessionEntry(toSessionAccessScope(params), params.entry);
}

async function createSessionEntry(
  params: Parameters<PluginRuntime["agent"]["session"]["createSessionEntry"]>[0],
): Promise<Awaited<ReturnType<PluginRuntime["agent"]["session"]["createSessionEntry"]>>> {
  // Session creation stays behind the canonical Gateway lifecycle boundary while
  // keeping that heavier runtime out of plugin discovery and cold startup.
  const [{ createGatewaySession }, { resolveGatewaySessionStoreTarget }] = await Promise.all([
    import("../../gateway/session-create-service.js"),
    import("../../gateway/session-utils.js"),
  ]);
  type CreatedContext = Parameters<
    NonNullable<Parameters<typeof createGatewaySession>[0]["afterCreate"]>
  >[0];
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
  });
  const cliInitial = "cliBackendId" in params.initialEntry ? params.initialEntry : undefined;
  const harnessInitial = "agentHarnessId" in params.initialEntry ? params.initialEntry : undefined;
  const identities = new Set([target.canonicalKey, ...target.storeKeys]);
  return await runExclusiveSessionLifecycleMutation({
    scope: target.storePath,
    identities,
    prepare: async () => {
      // Activate the mutation fence before checking admission state. New work
      // then queues, while pre-existing work makes creation fail without interruption.
      if (isSessionWorkAdmissionActive(target.storePath, identities)) {
        throw new Error(`Session "${target.canonicalKey}" is still active; retry creation later.`);
      }
    },
    run: async () => {
      const afterCreate = params.afterCreate;
      let callbackContext: CreatedContext | undefined;
      let finalEntryPatch: { pluginExtensions: SessionEntry["pluginExtensions"] } | undefined;
      let rollbackExpectedEntry: SessionEntry | undefined;
      const runAfterCreate = async (context: CreatedContext): Promise<void> => {
        callbackContext = context;
        rollbackExpectedEntry = structuredClone(context.entry);
        if (!afterCreate) {
          return;
        }
        const finalPatch = await afterCreate({
          key: context.key,
          agentId: context.agentId,
          sessionId: context.entry.sessionId,
          entry: structuredClone(context.entry),
        });
        if (finalPatch === undefined) {
          return;
        }
        const patchKeys = Object.keys(finalPatch);
        if (patchKeys.length !== 1 || patchKeys[0] !== "pluginExtensions") {
          throw new Error("session creation final patch may only contain pluginExtensions");
        }
        finalEntryPatch = {
          pluginExtensions: structuredClone(finalPatch.pluginExtensions),
        };
      };
      try {
        const matchingEntry =
          params.recoverMatchingInitialEntry === true
            ? getSessionEntry({
                sessionKey: target.canonicalKey,
                storePath: target.storePath,
                readConsistency: "latest",
              })
            : undefined;
        let recovered = false;
        let created: { key: string; agentId: string; entry: SessionEntry };
        if (matchingEntry) {
          const expectedSpawnedCwd = params.spawnedCwd?.trim() || undefined;
          const expectedExecNode = params.execNode?.trim() || undefined;
          const expectedExecCwd = params.execCwd?.trim() || undefined;
          const initialEntryMatches =
            matchingEntry.initializationPending === true &&
            matchingEntry.agentHarnessId === harnessInitial?.agentHarnessId &&
            matchingEntry.pluginOwnerId === cliInitial?.pluginOwnerId &&
            matchingEntry.modelSelectionLocked === params.initialEntry.modelSelectionLocked &&
            (!cliInitial ||
              (matchingEntry.providerOverride === cliInitial.cliBackendId &&
                matchingEntry.modelOverride === cliInitial.model &&
                isDeepStrictEqual(
                  matchingEntry.cliSessionBindings?.[cliInitial.cliBackendId],
                  cliInitial.cliSessionBinding,
                ))) &&
            matchingEntry.spawnedCwd === expectedSpawnedCwd &&
            matchingEntry.execNode === expectedExecNode &&
            matchingEntry.execCwd === expectedExecCwd &&
            isDeepStrictEqual(matchingEntry.pluginExtensions, params.initialEntry.pluginExtensions);
          if (!initialEntryMatches) {
            throw new Error(
              `Session "${target.canonicalKey}" does not match its trusted recovery state.`,
            );
          }
          if (!afterCreate) {
            throw new Error("session creation recovery requires an initializer");
          }
          recovered = true;
          created = {
            key: target.canonicalKey,
            agentId: target.agentId,
            entry: matchingEntry,
          };
          await runAfterCreate({
            ...created,
            storePath: target.storePath,
          });
        } else {
          const result = await createGatewaySession({
            cfg: params.cfg,
            key: params.key,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            ...(params.label !== undefined ? { label: params.label } : {}),
            ...(params.spawnedCwd !== undefined ? { spawnedCwd: params.spawnedCwd } : {}),
            ...(params.execNode !== undefined ? { execNode: params.execNode } : {}),
            ...(params.execCwd !== undefined ? { execCwd: params.execCwd } : {}),
            initialEntry: {
              ...(harnessInitial ? { agentHarnessId: harnessInitial.agentHarnessId } : {}),
              ...(cliInitial
                ? {
                    pluginOwnerId: cliInitial.pluginOwnerId,
                    providerOverride: cliInitial.cliBackendId,
                    modelOverride: cliInitial.model,
                    cliSessionBindings: {
                      [cliInitial.cliBackendId]: cliInitial.cliSessionBinding,
                    },
                  }
                : {}),
              ...(params.initialEntry.modelSelectionLocked === true
                ? { modelSelectionLocked: true }
                : {}),
              ...(params.initialEntry.pluginExtensions
                ? { pluginExtensions: params.initialEntry.pluginExtensions }
                : {}),
              ...(afterCreate ? { initializationPending: true } : {}),
            },
            ...(harnessInitial ? { authorizedAgentHarnessId: harnessInitial.agentHarnessId } : {}),
            ...(cliInitial?.pluginOwnerId ? { authorizedPluginId: cliInitial.pluginOwnerId } : {}),
            creation: {
              via: "plugin",
              actor: {
                type: "system",
                ...(cliInitial?.pluginOwnerId ? { id: cliInitial.pluginOwnerId } : {}),
              },
            },
            commandSource: "plugin-runtime",
            ...(afterCreate ? { afterCreate: runAfterCreate } : {}),
          });
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          created = result;
        }
        if (recovered && !finalEntryPatch) {
          throw new Error("session creation recovery requires a final patch");
        }
        let finalEntry = created.entry;
        if (afterCreate) {
          const patch: Partial<SessionEntry> = {
            ...finalEntryPatch,
            initializationPending: undefined,
          };
          const expectedEntry = rollbackExpectedEntry;
          if (!callbackContext || !expectedEntry) {
            throw new Error("session creation final patch is missing its created entry");
          }
          const createdContext = callbackContext;
          const finalized = await patchAccessorSessionEntry(
            {
              sessionKey: createdContext.key,
              storePath: createdContext.storePath,
            },
            (currentEntry) => {
              if (JSON.stringify(currentEntry) !== JSON.stringify(expectedEntry)) {
                throw new Error(
                  `created session ${createdContext.key} changed before finalization`,
                );
              }
              return patch;
            },
            {
              preserveActivity: true,
              requireWriteSuccess: true,
            },
          );
          if (!finalized) {
            throw new Error(
              `created session ${createdContext.key} disappeared before finalization`,
            );
          }
          finalEntry = finalized;
          // Any failure after persistence must compare rollback against the
          // finalized snapshot, not the now-stale initializing entry.
          rollbackExpectedEntry = structuredClone(finalized);
        }
        return {
          key: created.key,
          agentId: created.agentId,
          sessionId: finalEntry.sessionId,
          entry: finalEntry,
        };
      } catch (error) {
        if (!callbackContext) {
          throw error;
        }
        try {
          // Delete only the untouched row created for this callback. A concurrent
          // claimant changes the snapshot and must survive failed initialization.
          const expectedEntry = rollbackExpectedEntry ?? callbackContext.entry;
          const rollbackParams = {
            agentId: callbackContext.agentId,
            archiveTranscript: true,
            expectedEntry,
            expectedSessionId: callbackContext.entry.sessionId,
            expectedUpdatedAt: expectedEntry.updatedAt,
            storePath: callbackContext.storePath,
            target: {
              canonicalKey: callbackContext.key,
              storeKeys: [callbackContext.key],
            },
          };
          // Locked rows require owner-specific rollback capabilities. Unlocked
          // initializers stay on the ordinary guarded lifecycle deletion path.
          const rolledBack =
            expectedEntry.modelSelectionLocked === true
              ? expectedEntry.agentHarnessId
                ? await rollbackAgentHarnessSessionEntryLifecycle(rollbackParams)
                : await rollbackPluginOwnedSessionEntryLifecycle({
                    ...rollbackParams,
                    expectedPluginOwnerId: cliInitial?.pluginOwnerId ?? "",
                  })
              : await deleteSessionEntryLifecycle(rollbackParams);
          if (!rolledBack.deleted) {
            throw new Error(`created session ${callbackContext.key} changed before rollback`, {
              cause: error,
            });
          }
        } catch (rollbackError) {
          const aggregateError = new AggregateError(
            [error, rollbackError],
            `Session initialization failed and guarded rollback did not complete for ${callbackContext.key}.`,
            { cause: rollbackError },
          );
          throw aggregateError;
        }
        throw error;
      }
    },
  });
}

async function runWithSessionWorkAdmission<T>(
  params: { storePath: string; sessionKey: string; signal?: AbortSignal },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const initialEntry = getSessionEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const lifecycleAbortController = new AbortController();
  const admission = await beginSessionWorkAdmission({
    scope: params.storePath,
    identities: [params.sessionKey, initialEntry?.sessionId],
    signal: params.signal,
    onInterrupt: () =>
      lifecycleAbortController.abort(
        new Error("Agent work interrupted by a session lifecycle change."),
      ),
    assertAllowed: () => {
      const currentEntry = getSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      });
      const changed = initialEntry
        ? !currentEntry || currentEntry.sessionId !== initialEntry.sessionId
        : Boolean(currentEntry);
      if (changed) {
        throw new Error(`Session "${params.sessionKey}" changed while starting work. Retry.`);
      }
      const archivedSessionError = resolveSessionWorkStartError(params.sessionKey, currentEntry);
      if (archivedSessionError) {
        throw new Error(archivedSessionError);
      }
    },
  });

  try {
    const signal = params.signal
      ? AbortSignal.any([params.signal, lifecycleAbortController.signal])
      : lifecycleAbortController.signal;
    return await admission.run(async () => await run(signal));
  } finally {
    admission.release();
  }
}

/** Creates the plugin runtime agent facade with lazy embedded-agent/session helpers. */
export function createRuntimeAgent(): PluginRuntime["agent"] {
  const agentRuntime = {
    defaults: { model: DEFAULT_MODEL, provider: DEFAULT_PROVIDER },
    resolveAgentDir,
    resolveAgentWorkspaceDir,
    resolveAgentIdentity,
    resolveThinkingDefault,
    normalizeThinkingLevel: normalizeThinkLevel,
    resolveThinkingPolicy: (params) => {
      const cfg = getRuntimeConfig();
      const effectiveRuntime = params.agentRuntime
        ? concretizeAgentRuntime(params.agentRuntime)
        : params.provider && params.model
          ? resolveEffectiveAgentRuntime({
              cfg,
              provider: params.provider,
              modelId: params.model,
            })
          : undefined;
      const profile = resolveThinkingProfile({
        ...params,
        agentRuntime: effectiveRuntime,
        catalog: resolveRuntimeThinkingCatalog(params, () =>
          buildConfiguredModelCatalog({ cfg: getRuntimeConfig() }),
        ),
      });
      const policy: Omit<
        ReturnType<PluginRuntime["agent"]["resolveThinkingPolicy"]>,
        "defaultLevel"
      > = {
        levels: profile.levels.map(({ id, label }) => ({ id, label })),
      };
      return profile.defaultLevel ? { ...policy, defaultLevel: profile.defaultLevel } : policy;
    },
    resolveAgentTimeoutMs,
    resolveCliBackendDispatchEligibility: resolveEmbeddedCliBackendDispatchEligibility,
    ensureAgentWorkspace,
  } satisfies Omit<PluginRuntime["agent"], "runEmbeddedAgent" | "runEmbeddedPiAgent" | "session"> &
    Partial<Pick<PluginRuntime["agent"], "runEmbeddedAgent" | "runEmbeddedPiAgent" | "session">>;

  defineCachedValue(agentRuntime, "runEmbeddedAgent", () =>
    createLazyRuntimeMethod(loadEmbeddedAgentRuntime, (runtime) => runtime.runEmbeddedAgent),
  );
  defineCachedValue(
    agentRuntime,
    "runEmbeddedPiAgent",
    () => (agentRuntime as PluginRuntime["agent"]).runEmbeddedAgent,
  );
  defineCachedValue(agentRuntime, "session", () => ({
    resolveStorePath,
    createSessionEntry,
    getSessionEntry,
    listSessionEntries,
    patchSessionEntry,
    upsertSessionEntry,
    runWithWorkAdmission: runWithSessionWorkAdmission,
    updateSessionStoreEntry,
  }));

  return agentRuntime as PluginRuntime["agent"];
}
