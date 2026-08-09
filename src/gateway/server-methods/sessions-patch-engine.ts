import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchManyTarget,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import type { SessionEntry } from "../../config/sessions.js";
import { applySessionPatchProjections } from "../../config/sessions/session-accessor.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
  SESSION_ARCHIVE_ACTIVE_RUN_ERROR,
} from "../../sessions/session-lifecycle-admission.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveGatewaySessionThinkingProjection,
  resolveSessionDisplayModelIdentityRef,
  resolveSessionModelRef,
  type SessionsPatchResult,
} from "../session-utils.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { hasVisibleActiveSessionRun } from "./session-active-runs.js";
import { appendSessionAudit } from "./session-audit.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  isAgentMainSessionKey,
  resolveGatewaySessionTargetFromKey,
  resolveSessionWorkerPlacementPatchError,
  sessionLog,
} from "./sessions-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./types.js";

type PatchTargetIdentity = Pick<
  SessionsPatchManyTarget,
  "agentId" | "expectedLifecycleRevision" | "expectedSessionId" | "key"
>;

type PreparedPatchTarget = {
  archiveActor: ReturnType<typeof gatewayClientSessionCreator>;
  canonicalKey: string;
  fullPatch: SessionsPatchParams;
  index: number;
  initialEntry?: SessionEntry;
  key: string;
  lifecycleIdentities: Array<string | undefined>;
  modelCatalog?: Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>;
  requestedAgentId?: string;
  storePath: string;
  target: ReturnType<typeof resolveGatewaySessionTargetFromKey>["target"];
  wasArchivedBeforePatch: boolean;
};

type SessionPatchEngineOutcome =
  | {
      ok: true;
      agentId?: string;
      entry: SessionEntry;
      key: string;
      result?: SessionsPatchResult;
    }
  | {
      ok: false;
      agentId?: string;
      error: ErrorShape;
      key: string;
    };

type SessionPatchEngineResult =
  | { ok: false; error: ErrorShape }
  | { ok: true; outcomes: SessionPatchEngineOutcome[] };

function targetIdentity(target: PatchTargetIdentity) {
  return {
    key: target.key,
    ...(target.agentId ? { agentId: target.agentId } : {}),
  };
}

function unexpectedPatchError(key: string, error: unknown): ErrorShape {
  sessionLog.warn(`sessions.patch: target failed for ${key}: ${formatErrorMessage(error)}`);
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    "Session patch failed unexpectedly. Retry the request.",
    {
      retryable: true,
    },
  );
}

function targetFailure(target: PatchTargetIdentity, error: ErrorShape): SessionPatchEngineOutcome {
  return { ok: false, ...targetIdentity(target), error };
}

function pluginOwnershipError(params: {
  client: GatewayClient | null;
  entry: SessionEntry | undefined;
  key: string;
}): ErrorShape | undefined {
  return resolvePluginSessionOwnershipError({
    action: "patch",
    entry: params.entry,
    key: params.key,
    pluginOwnerId: params.client?.internal?.pluginRuntimeOwnerId,
  });
}

export async function executeSessionPatchEngine(params: {
  authorizationMode: "request" | "target";
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  targets: readonly PatchTargetIdentity[];
}): Promise<SessionPatchEngineResult> {
  const cfg = params.context.getRuntimeConfig();
  const storeCache = new Map<string, Record<string, SessionEntry>>();
  const targetDiscoveryCache = new Map();
  const preflightTargets = params.targets.map((target) => ({
    input: target,
    resolved: resolveGatewaySessionTargetFromKey(target.key.trim(), cfg, {
      ...(target.agentId ? { agentId: target.agentId } : {}),
      exactRead: true,
      storeCache,
      targetDiscoveryCache,
    }),
  }));
  const logicalTargets = new Set<string>();
  for (const { input, resolved } of preflightTargets) {
    const logicalId = `${resolved.storePath}\0${resolved.target.canonicalKey ?? input.key}`;
    if (logicalTargets.has(logicalId)) {
      return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "Duplicate target.") };
    }
    logicalTargets.add(logicalId);
  }

  const outcomes: Array<SessionPatchEngineOutcome | undefined> = Array.from({
    length: params.targets.length,
  });
  const prepared: PreparedPatchTarget[] = [];
  for (const [index, { input, resolved }] of preflightTargets.entries()) {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, input.agentId);
    if (!requestedAgent.ok) {
      outcomes[index] = targetFailure(input, requestedAgent.error);
      continue;
    }
    const requestedAgentId = requestedAgent.agentId;
    const { target, storePath } = resolved;
    let initialEntry: SessionEntry | undefined;
    try {
      initialEntry = resolveCanonicalGatewaySessionStoreKey({
        cfg,
        key,
        store: target.store,
        agentId: requestedAgentId,
      }).entry;
    } catch (error) {
      outcomes[index] = targetFailure(input, unexpectedPatchError(key, error));
      continue;
    }
    const canonicalKey = target.canonicalKey ?? key;
    const ownershipError = pluginOwnershipError({
      client: params.client,
      entry: initialEntry,
      key: canonicalKey,
    });
    if (ownershipError) {
      outcomes[index] = targetFailure(input, ownershipError);
      continue;
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      canonicalKey,
      initialEntry,
    );
    if (missingHarnessSessionError) {
      outcomes[index] = targetFailure(
        input,
        errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError),
      );
      continue;
    }
    const fullPatch = Object.assign({}, input, params.patch) as SessionsPatchParams;
    let initialPlacementPatchError: string | undefined;
    try {
      initialPlacementPatchError = resolveSessionWorkerPlacementPatchError({
        agentId: target.agentId,
        cfg,
        context: params.context,
        entry: initialEntry,
        key,
        patch: fullPatch,
        sessionKey: canonicalKey,
        validateModelRuntime: false,
      });
    } catch (error) {
      outcomes[index] = targetFailure(input, unexpectedPatchError(key, error));
      continue;
    }
    if (initialPlacementPatchError) {
      outcomes[index] = targetFailure(
        input,
        errorShape(ErrorCodes.INVALID_REQUEST, initialPlacementPatchError),
      );
      continue;
    }
    const lifecycleIdentities = [canonicalKey, key, initialEntry?.sessionId];
    if (
      fullPatch.archived === true &&
      isSessionLifecycleMutationActive(storePath, lifecycleIdentities)
    ) {
      outcomes[index] = targetFailure(
        input,
        errorShape(ErrorCodes.INVALID_REQUEST, SESSION_ARCHIVE_ACTIVE_RUN_ERROR),
      );
      continue;
    }
    prepared.push({
      archiveActor: gatewayClientSessionCreator(params.client),
      canonicalKey,
      fullPatch,
      index,
      ...(initialEntry ? { initialEntry } : {}),
      key,
      lifecycleIdentities,
      ...(requestedAgentId ? { requestedAgentId } : {}),
      storePath,
      target,
      wasArchivedBeforePatch: false,
    });
  }

  const modelCatalogByAgent = new Map<
    string,
    Promise<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>
  >();
  const loadModelCatalog = async (target: PreparedPatchTarget) => {
    const cacheKey = target.target.agentId;
    let promise = modelCatalogByAgent.get(cacheKey);
    if (!promise) {
      promise = params.context.loadGatewayModelCatalog({ agentId: target.target.agentId });
      modelCatalogByAgent.set(cacheKey, promise);
    }
    const catalog = await promise;
    target.modelCatalog = catalog;
    return catalog;
  };

  if (prepared.length > 0) {
    await runExclusiveSessionLifecycleMutation({
      targets: prepared.map((target) => ({
        scope: target.storePath,
        identities: target.lifecycleIdentities,
      })),
      run: async () => {
        const groups = new Map<string, PreparedPatchTarget[]>();
        for (const target of prepared) {
          const groupKey = `${target.storePath}\0${target.target.agentId}`;
          groups.set(groupKey, [...(groups.get(groupKey) ?? []), target]);
        }
        await Promise.all(
          [...groups.values()].map(async (group) => {
            try {
              const projected = await applySessionPatchProjections({
                agentId: group[0]?.target.agentId,
                storePath: group[0]?.storePath ?? "",
                operations: group.map((preparedTarget) => ({
                  resolveTarget: ({ store }) => {
                    const { target: migratedTarget, primaryKey } =
                      resolveCanonicalGatewaySessionStoreKey({
                        cfg,
                        key: preparedTarget.key,
                        store: store as Record<string, SessionEntry>,
                        agentId: preparedTarget.requestedAgentId,
                      });
                    return { primaryKey, candidateKeys: migratedTarget.storeKeys };
                  },
                  project: async ({ primaryKey, existingEntry, isLabelInUse }) => {
                    const ownershipError = pluginOwnershipError({
                      client: params.client,
                      entry: existingEntry,
                      key: preparedTarget.canonicalKey,
                    });
                    if (ownershipError) {
                      return { ok: false as const, error: ownershipError };
                    }
                    const initialEntry = preparedTarget.initialEntry;
                    const expectedSessionChanged =
                      (preparedTarget.fullPatch.expectedSessionId !== undefined &&
                        existingEntry?.sessionId !== preparedTarget.fullPatch.expectedSessionId) ||
                      (preparedTarget.fullPatch.expectedLifecycleRevision !== undefined &&
                        existingEntry?.lifecycleRevision !==
                          preparedTarget.fullPatch.expectedLifecycleRevision);
                    const lifecycleEntryRemoved =
                      initialEntry !== undefined && existingEntry === undefined;
                    const archiveTargetChanged =
                      preparedTarget.fullPatch.archived === true &&
                      (initialEntry === undefined
                        ? existingEntry !== undefined
                        : existingEntry !== undefined &&
                          (existingEntry.sessionId !== initialEntry.sessionId ||
                            existingEntry.lifecycleRevision !== initialEntry.lifecycleRevision));
                    if (expectedSessionChanged || lifecycleEntryRemoved || archiveTargetChanged) {
                      return {
                        ok: false as const,
                        error: errorShape(
                          ErrorCodes.INVALID_REQUEST,
                          `Session ${preparedTarget.key} changed before patch. Retry.`,
                        ),
                      };
                    }
                    if (preparedTarget.fullPatch.archived === true) {
                      if (
                        preparedTarget.canonicalKey === "global" ||
                        isAgentMainSessionKey(cfg, preparedTarget.canonicalKey)
                      ) {
                        return {
                          ok: false as const,
                          error: errorShape(
                            ErrorCodes.INVALID_REQUEST,
                            "Cannot archive an agent's main session.",
                          ),
                        };
                      }
                      const activeIdentities = [
                        preparedTarget.canonicalKey,
                        preparedTarget.key,
                        existingEntry?.sessionId,
                      ];
                      if (
                        isSessionWorkAdmissionActive(preparedTarget.storePath, activeIdentities) ||
                        replyRunRegistry.isActive(preparedTarget.canonicalKey) ||
                        replyRunRegistry.isActive(preparedTarget.key) ||
                        hasVisibleActiveSessionRun({
                          context: params.context,
                          requestedKey: preparedTarget.key,
                          canonicalKey: preparedTarget.canonicalKey,
                          sessionId: existingEntry?.sessionId,
                          defaultAgentId: resolveDefaultAgentId(cfg),
                        })
                      ) {
                        return {
                          ok: false as const,
                          error: errorShape(
                            ErrorCodes.INVALID_REQUEST,
                            SESSION_ARCHIVE_ACTIVE_RUN_ERROR,
                          ),
                        };
                      }
                    }
                    preparedTarget.wasArchivedBeforePatch = existingEntry?.archivedAt !== undefined;
                    const result = await projectSessionsPatchEntry({
                      cfg,
                      existingEntry,
                      isLabelInUse,
                      storeKey: primaryKey,
                      agentId: preparedTarget.requestedAgentId,
                      patch: preparedTarget.fullPatch,
                      archivedBy: preparedTarget.archiveActor,
                      loadGatewayModelCatalog: () => loadModelCatalog(preparedTarget),
                    });
                    if (!result.ok) {
                      return result;
                    }
                    const placementPatchError = resolveSessionWorkerPlacementPatchError({
                      agentId: preparedTarget.target.agentId,
                      cfg,
                      context: params.context,
                      entry: result.entry,
                      key: preparedTarget.key,
                      patch: preparedTarget.fullPatch,
                      sessionKey: preparedTarget.canonicalKey,
                      validateModelRuntime: true,
                    });
                    return placementPatchError
                      ? {
                          ok: false as const,
                          error: errorShape(ErrorCodes.INVALID_REQUEST, placementPatchError),
                        }
                      : result;
                  },
                  authorize: () => {
                    try {
                      if (params.authorizationMode === "request") {
                        params.sessionMutationAuthorization?.assertCurrent();
                      } else {
                        const inputTarget = params.targets[preparedTarget.index]!;
                        params.sessionMutationAuthorization?.assertTargetCurrent({
                          sessionKey: preparedTarget.key,
                          ...(inputTarget.agentId ? { agentId: inputTarget.agentId } : {}),
                        });
                      }
                      return undefined;
                    } catch (error) {
                      return {
                        ok: false as const,
                        error:
                          error instanceof SessionMutationAuthorizationChangedError
                            ? error.error
                            : unexpectedPatchError(preparedTarget.key, error),
                      };
                    }
                  },
                  onError: (error) => ({
                    ok: false as const,
                    error: unexpectedPatchError(preparedTarget.key, error),
                  }),
                })),
              });
              for (const [groupIndex, result] of projected.entries()) {
                const target = group[groupIndex];
                if (!target || !result) {
                  continue;
                }
                outcomes[target.index] = result.ok
                  ? {
                      ok: true,
                      ...targetIdentity(params.targets[target.index]!),
                      entry: result.entry,
                      ...(params.authorizationMode === "request"
                        ? { result: projectPatchResponse(cfg, target, result.entry) }
                        : {}),
                    }
                  : targetFailure(params.targets[target.index]!, result.error);
              }
            } catch (error) {
              for (const target of group) {
                outcomes[target.index] = targetFailure(
                  params.targets[target.index]!,
                  unexpectedPatchError(target.key, error),
                );
              }
            }
          }),
        );

        for (const target of prepared.toSorted((left, right) => left.index - right.index)) {
          const outcome = outcomes[target.index];
          if (!outcome?.ok || !target.archiveActor) {
            continue;
          }
          const archiveStateChanged =
            typeof target.fullPatch.archived === "boolean" &&
            target.wasArchivedBeforePatch !== (outcome.entry.archivedAt !== undefined);
          if (!archiveStateChanged) {
            continue;
          }
          const action = outcome.entry.archivedAt === undefined ? "unarchived" : "archived";
          try {
            await appendSessionAudit({
              cfg,
              target: {
                agentId: target.target.agentId,
                entry: outcome.entry,
                sessionKey: target.canonicalKey,
                storePath: target.storePath,
              },
              text: `${action} by ${target.archiveActor.label ?? target.archiveActor.id}`,
              now: Date.now(),
            });
          } catch (error) {
            sessionLog.warn(
              `sessions.patch: ${action} audit note failed for ${target.canonicalKey}; archive kept: ${formatErrorMessage(error)}`,
            );
          }
        }
      },
    });
  }

  const successful = prepared.filter((target) => outcomes[target.index]?.ok);
  for (const target of successful) {
    const outcome = outcomes[target.index];
    if (!outcome?.ok) {
      continue;
    }
    triggerSessionPatchHook({
      cfg,
      sessionEntry: outcome.entry,
      sessionKey: target.canonicalKey,
      patch: target.fullPatch,
    });
    persistPatchModelSelection({
      cfg,
      client: params.client,
      entry: outcome.entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.target.agentId,
    });
    emitSessionsChanged(params.context, {
      sessionKey: target.canonicalKey,
      ...(target.canonicalKey === "global" && target.requestedAgentId
        ? { agentId: target.requestedAgentId }
        : {}),
      reason: "patch",
    });
  }

  if (
    successful.length > 0 &&
    typeof params.patch.category === "string" &&
    params.patch.category.trim()
  ) {
    ensureSessionGroupRegistered(params.patch.category);
  }

  const callerScopes = Array.isArray(params.client?.connect?.scopes)
    ? params.client.connect.scopes
    : [];
  const callerCanManageCron = params.client === null || callerScopes.includes(ADMIN_SCOPE);
  const archivedSessionKeys = successful.flatMap((target) =>
    target.fullPatch.archived === true ? [target.canonicalKey] : [],
  );
  if (callerCanManageCron && archivedSessionKeys.length > 0) {
    try {
      const disabledBySession = await disableCronJobsBoundToSessions({
        cron: params.context.cron,
        cfg,
        sessionKeys: archivedSessionKeys,
      });
      for (const [sessionKey, disabledJobIds] of disabledBySession) {
        if (disabledJobIds.length > 0) {
          sessionLog.info(
            `sessions.patch: disabled cron jobs bound to archived session ${sessionKey}: ${disabledJobIds.join(", ")}`,
          );
        }
      }
    } catch (error) {
      sessionLog.warn(
        `sessions.patch: failed to disable cron jobs for archived sessions: ${formatErrorMessage(error)}`,
      );
    }
  }

  return {
    ok: true,
    outcomes: outcomes.map(
      (outcome, index) =>
        outcome ??
        targetFailure(
          params.targets[index]!,
          unexpectedPatchError(params.targets[index]!.key, "missing patch outcome"),
        ),
    ),
  };
}

function projectPatchResponse(
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>,
  target: PreparedPatchTarget,
  entry: SessionEntry,
): SessionsPatchResult {
  const parsed = parseAgentSessionKey(target.canonicalKey);
  const agentId = normalizeAgentId(
    target.canonicalKey === "global"
      ? target.target.agentId
      : (parsed?.agentId ?? resolveDefaultAgentId(cfg)),
  );
  const resolved = resolveSessionModelRef(cfg, entry, agentId);
  const resolvedDisplayModel = resolveSessionDisplayModelIdentityRef({
    cfg,
    agentId,
    provider: resolved.provider,
    model: resolved.model,
  });
  const thinkingProjection = resolveGatewaySessionThinkingProjection({
    cfg,
    agentId,
    provider: resolvedDisplayModel.provider ?? resolved.provider,
    model: resolvedDisplayModel.model ?? resolved.model,
    sessionKey: target.canonicalKey,
    entry,
    modelCatalog: target.modelCatalog,
  });
  const resolvedThinkingMetadata =
    target.modelCatalog === undefined
      ? {}
      : {
          thinkingLevel: thinkingProjection.effectiveThinkingLevel,
          thinkingLevels: thinkingProjection.thinkingLevels,
        };
  return {
    ok: true,
    path: target.storePath,
    key: target.target.canonicalKey,
    entry,
    resolved: {
      modelProvider: resolvedDisplayModel.provider,
      model: resolvedDisplayModel.model,
      agentRuntime: thinkingProjection.agentRuntime,
      ...resolvedThinkingMetadata,
    },
  };
}

function persistPatchModelSelection(params: {
  client: GatewayClient | null;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  sessionKey: string;
  targetAgentId: string;
}): void {
  const callerScopes = Array.isArray(params.client?.connect?.scopes)
    ? params.client.connect.scopes
    : [];
  const parsed = parseAgentSessionKey(params.sessionKey);
  const agentId = normalizeAgentId(
    params.sessionKey === "global"
      ? params.targetAgentId
      : (parsed?.agentId ?? resolveDefaultAgentId(params.cfg)),
  );
  const resolved = resolveSessionModelRef(params.cfg, params.entry, agentId);
  if (
    typeof params.patch.model === "string" &&
    callerScopes.includes(ADMIN_SCOPE) &&
    params.entry.modelOverrideSource === "user" &&
    params.entry.providerOverride &&
    params.entry.modelOverride
  ) {
    persistStickyModelSelectionBestEffort({
      agentId,
      model: `${resolved.provider}/${resolved.model}`,
    });
  }
}
