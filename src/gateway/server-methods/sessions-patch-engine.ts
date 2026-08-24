import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchManyResult,
  type SessionsPatchManyTarget,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions/lifecycle.js";
import {
  applySessionEntryCanonicalReplacements,
  type SessionEntryCanonicalReplacement,
} from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { SessionLabelOwnerIndex } from "../../config/sessions/session-entry-selection.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { ensureSessionGroupRegistered } from "../session-groups.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { projectSessionPatchResult } from "../session-utils-model.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
  type SessionsPatchResult,
} from "../session-utils.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import {
  prepareSessionPatchArchive,
  type SessionPatchArchivePreparation,
  validateSessionPatchArchiveProjection,
} from "./sessions-patch-archive.js";
import { persistSessionPatchModelSelection } from "./sessions-patch-model-selection.js";
import { resolveSessionWorkerPlacementPatchError, sessionLog } from "./sessions-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./types.js";

type PatchTargetIdentity = Pick<
  SessionsPatchManyTarget,
  "agentId" | "expectedLifecycleRevision" | "expectedSessionId" | "key"
>;

type MutationTarget = PatchTargetIdentity & {
  commitGuard: () => ErrorShape | undefined;
};

type PreparedPatchTarget = {
  archiveActor: ReturnType<typeof gatewayClientSessionCreator>;
  archivePreparation?: SessionPatchArchivePreparation;
  canonicalKey: string;
  fullPatch: SessionsPatchParams;
  index: number;
  initialEntry?: SessionEntry;
  initialStoreKeys: string[];
  key: string;
  lifecycleIdentities: Array<string | undefined>;
  requestedAgentId?: string;
  storePath: string;
  targetAgentId: string;
};

type MutationOutcome = { ok: true; entry: SessionEntry } | { ok: false; error: ErrorShape };

type ModelCatalog = Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>;

type MutationCoreResult =
  | { ok: false; error: ErrorShape }
  | {
      ok: true;
      cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      outcomes: MutationOutcome[];
      preparedByIndex: Array<PreparedPatchTarget | undefined>;
      modelCatalogByAgent: Map<string, Promise<ModelCatalog>>;
    };

function unexpectedPatchError(key: string, error: unknown): ErrorShape {
  sessionLog.warn(`sessions.patch: target failed for ${key}: ${formatErrorMessage(error)}`);
  const message = "Session patch failed unexpectedly. Retry the request.";
  return errorShape(ErrorCodes.UNAVAILABLE, message, { retryable: true });
}

function sessionChangedError(key: string): ErrorShape {
  return errorShape(ErrorCodes.INVALID_REQUEST, `Session ${key} changed before patch. Retry.`, {
    details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
  });
}

function pluginOwnershipError(
  client: GatewayClient | null,
  entry: SessionEntry | undefined,
  key: string,
): ErrorShape | undefined {
  return resolvePluginSessionOwnershipError({
    action: "patch",
    entry,
    key,
    pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
  });
}

function createCommitGuard(key: string, assertCurrent: (() => void) | undefined) {
  return (): ErrorShape | undefined => {
    try {
      assertCurrent?.();
      return undefined;
    } catch (error) {
      return error instanceof SessionMutationAuthorizationChangedError
        ? error.error
        : unexpectedPatchError(key, error);
    }
  };
}

async function executeSessionPatchMutations(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  targets: readonly MutationTarget[];
}): Promise<MutationCoreResult> {
  const { client } = params;
  const cfg = params.context.getRuntimeConfig();
  const creation = resolveOperatorSessionCreation(client);
  const archiveActor = gatewayClientSessionCreator(client);
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const callerCanManageCron = client === null || callerScopes.includes(ADMIN_SCOPE);
  const pluginOwnerId = client?.internal?.pluginRuntimeOwnerId;
  const targetDiscoveryCache = new Map();
  const preflightTargets = params.targets.map((input) => {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, input.agentId);
    return {
      input,
      key,
      requestedAgent,
      resolved: requestedAgent.ok
        ? resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key,
            agentId: requestedAgent.agentId,
            exactRead: true,
            targetDiscoveryCache,
          })
        : undefined,
    };
  });
  const logicalTargets = new Set<string>();
  for (const { key, resolved } of preflightTargets) {
    if (!resolved) {
      continue;
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey ?? key}`;
    if (logicalTargets.has(logicalId)) {
      return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "Duplicate target.") };
    }
    logicalTargets.add(logicalId);
  }

  const outcomes = Array.from<MutationOutcome | undefined>({ length: params.targets.length });
  const prepared: PreparedPatchTarget[] = [];
  const preparedByIndex = Array.from<PreparedPatchTarget | undefined>({
    length: params.targets.length,
  });
  for (const [index, { input, key, requestedAgent, resolved }] of preflightTargets.entries()) {
    if (!requestedAgent.ok) {
      outcomes[index] = requestedAgent;
      continue;
    }
    if (!resolved) {
      outcomes[index] = {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, "Session target could not be resolved."),
      };
      continue;
    }
    const requestedAgentId = requestedAgent.agentId;
    const canonicalKey = resolved.canonicalKey ?? key;
    const candidateKeys = resolved.storeKeys;
    let initialEntry: SessionEntry | undefined;
    try {
      initialEntry = resolveCanonicalSessionEntryFromStoreKeys(resolved.store, [...candidateKeys]);
    } catch (error) {
      outcomes[index] = { ok: false, error: unexpectedPatchError(key, error) };
      continue;
    }
    const creationError =
      !initialEntry && authorizeGatewaySessionCreation({ cfg, client, agentId: resolved.agentId });
    if (creationError) {
      outcomes[index] = { ok: false, error: creationError };
      continue;
    }
    const ownershipError = pluginOwnershipError(client, initialEntry, canonicalKey);
    if (ownershipError) {
      outcomes[index] = { ok: false, error: ownershipError };
      continue;
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      canonicalKey,
      initialEntry,
    );
    if (missingHarnessSessionError) {
      outcomes[index] = {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError),
      };
      continue;
    }
    // Commit guards are core control state; construct the protocol patch from
    // its public identity fields so closures can never reach hooks or entries.
    const { commitGuard: _commitGuard, ...identity } = input;
    const fullPatch: SessionsPatchParams = { ...params.patch, ...identity };
    let initialPlacementPatchError: string | undefined;
    try {
      initialPlacementPatchError = resolveSessionWorkerPlacementPatchError({
        agentId: resolved.agentId,
        cfg,
        context: params.context,
        entry: initialEntry,
        key,
        patch: fullPatch,
        sessionKey: canonicalKey,
        validateModelRuntime: false,
      });
    } catch (error) {
      outcomes[index] = { ok: false, error: unexpectedPatchError(key, error) };
      continue;
    }
    if (initialPlacementPatchError) {
      outcomes[index] = {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, initialPlacementPatchError),
      };
      continue;
    }
    const lifecycleIdentities = Array.from(
      new Set([key, canonicalKey, ...candidateKeys, initialEntry?.sessionId]),
    );
    const preparedTarget: PreparedPatchTarget = {
      archiveActor,
      canonicalKey,
      fullPatch,
      index,
      ...(initialEntry ? { initialEntry } : {}),
      initialStoreKeys: [...candidateKeys],
      key,
      lifecycleIdentities,
      ...(requestedAgentId ? { requestedAgentId } : {}),
      storePath: resolved.storePath,
      targetAgentId: resolved.agentId,
    };
    prepared.push(preparedTarget);
    preparedByIndex[index] = preparedTarget;
  }

  const modelCatalogByAgent = new Map<string, Promise<ModelCatalog>>();
  const loadModelCatalog = (agentId: string) => {
    let promise = modelCatalogByAgent.get(agentId);
    if (!promise) {
      promise = params.context.loadGatewayModelCatalog({ agentId });
      modelCatalogByAgent.set(agentId, promise);
    }
    return promise;
  };

  if (prepared.length > 0) {
    try {
      await runExclusiveSessionLifecycleMutation({
        targets: prepared.map((target) => ({
          scope: target.storePath,
          identities: target.lifecycleIdentities,
        })),
        prepare: async () => {
          await Promise.all(
            prepared
              .filter((target) => target.fullPatch.archived === true)
              .map(async (target) => {
                try {
                  const result = await prepareSessionPatchArchive({
                    cfg,
                    commitGuard: params.targets[target.index]!.commitGuard,
                    context: params.context,
                    loadGatewayModelCatalog: () => loadModelCatalog(target.targetAgentId),
                    ...(pluginOwnerId ? { pluginOwnerId } : {}),
                    target,
                  });
                  if (result.ok) {
                    target.archivePreparation = result.value;
                  } else {
                    outcomes[target.index] = result;
                  }
                } catch (error) {
                  outcomes[target.index] = {
                    ok: false,
                    error: unexpectedPatchError(target.key, error),
                  };
                }
              }),
          );
        },
        run: async () => {
          const groups = new Map<string, PreparedPatchTarget[]>();
          for (const target of prepared) {
            if (target.fullPatch.archived === true && !target.archivePreparation) {
              continue;
            }
            const groupKey = `${target.storePath}\0${target.targetAgentId}`;
            const group = groups.get(groupKey);
            if (group) {
              group.push(target);
            } else {
              groups.set(groupKey, [target]);
            }
          }
          await Promise.all(
            [...groups.values()].map(async (group) => {
              const first = group[0]!;
              try {
                // Labels need store-wide uniqueness. Other single patches retain every resolver
                // candidate so writer-queued legacy aliases remain visible to revalidation.
                const selectedSessionKeys =
                  group.length === 1 && first.fullPatch.label === undefined
                    ? Array.from(
                        new Set([first.key, first.canonicalKey, ...first.initialStoreKeys]),
                      )
                    : undefined;
                const groupOutcomes = await applySessionEntryCanonicalReplacements({
                  agentId: first.targetAgentId,
                  ...(selectedSessionKeys ? { sessionKeys: selectedSessionKeys } : {}),
                  storePath: first.storePath,
                  skipMaintenance: true,
                  update: async (entries) => {
                    const workingStore = Object.fromEntries(
                      entries.flatMap(({ entry, sessionKey }) =>
                        isInternalSessionEffectsKey(sessionKey)
                          ? []
                          : [[sessionKey, entry] as const],
                      ),
                    );
                    const labelOwners = new SessionLabelOwnerIndex(workingStore);
                    const replacements: SessionEntryCanonicalReplacement[] = [];
                    const projectedOutcomes: MutationOutcome[] = [];
                    for (const target of group) {
                      try {
                        // Preflight facts can stale behind the writer queue; resolve this snapshot
                        // again so a new legacy alias is rejected rather than promoted or deleted.
                        const {
                          entry: existingEntry,
                          primaryKey,
                          target: currentTarget,
                        } = resolveCanonicalGatewaySessionStoreKey({
                          cfg,
                          key: target.key,
                          store: workingStore,
                          ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
                        });
                        const creationError =
                          !existingEntry &&
                          authorizeGatewaySessionCreation({
                            cfg,
                            client,
                            agentId: target.targetAgentId,
                          });
                        if (creationError) {
                          projectedOutcomes.push({ ok: false, error: creationError });
                          continue;
                        }
                        const candidateKeys = currentTarget.storeKeys;
                        const ownershipError = pluginOwnershipError(
                          client,
                          existingEntry,
                          primaryKey,
                        );
                        if (ownershipError) {
                          projectedOutcomes.push({ ok: false, error: ownershipError });
                          continue;
                        }
                        const expectedSessionChanged =
                          (target.fullPatch.expectedSessionId !== undefined &&
                            existingEntry?.sessionId !== target.fullPatch.expectedSessionId) ||
                          (target.fullPatch.expectedLifecycleRevision !== undefined &&
                            existingEntry?.lifecycleRevision !==
                              target.fullPatch.expectedLifecycleRevision);
                        const lifecycleEntryRemoved =
                          target.initialEntry !== undefined && existingEntry === undefined;
                        const archiveTargetChanged =
                          target.fullPatch.archived === true &&
                          (target.initialEntry === undefined
                            ? existingEntry !== undefined
                            : existingEntry !== undefined &&
                              (existingEntry.sessionId !== target.initialEntry.sessionId ||
                                existingEntry.lifecycleRevision !==
                                  target.initialEntry.lifecycleRevision));
                        if (
                          expectedSessionChanged ||
                          lifecycleEntryRemoved ||
                          archiveTargetChanged
                        ) {
                          projectedOutcomes.push({
                            ok: false,
                            error: sessionChangedError(target.key),
                          });
                          continue;
                        }
                        if (target.fullPatch.archived === true) {
                          const archiveError = validateSessionPatchArchiveProjection({
                            cfg,
                            existingEntry,
                            fullPatch: target.fullPatch,
                            key: target.key,
                            ...(pluginOwnerId ? { pluginOwnerId } : {}),
                            preparation: target.archivePreparation!,
                            primaryKey,
                          });
                          if (archiveError) {
                            projectedOutcomes.push({
                              ok: false,
                              error: archiveError,
                            });
                            continue;
                          }
                        }
                        const projected = await projectSessionsPatchEntry({
                          cfg,
                          creation,
                          existingEntry,
                          isLabelInUse: (label) => labelOwners.isLabelInUse(label, candidateKeys),
                          storeKey: primaryKey,
                          agentId: target.requestedAgentId,
                          patch: target.fullPatch,
                          archivedBy: archiveActor,
                          loadGatewayModelCatalog: () => loadModelCatalog(target.targetAgentId),
                        });
                        if (!projected.ok) {
                          projectedOutcomes.push(projected);
                          continue;
                        }
                        const placementPatchError = resolveSessionWorkerPlacementPatchError({
                          agentId: target.targetAgentId,
                          cfg,
                          context: params.context,
                          entry: projected.entry,
                          key: target.key,
                          patch: target.fullPatch,
                          sessionKey: primaryKey,
                          validateModelRuntime: true,
                        });
                        if (placementPatchError) {
                          projectedOutcomes.push({
                            ok: false,
                            error: errorShape(ErrorCodes.INVALID_REQUEST, placementPatchError),
                          });
                          continue;
                        }
                        const authorizationFailure = params.targets[target.index]!.commitGuard();
                        if (authorizationFailure) {
                          projectedOutcomes.push({ ok: false, error: authorizationFailure });
                          continue;
                        }
                        const previousSessionKeys = candidateKeys.filter(
                          (sessionKey) => sessionKey !== primaryKey && workingStore[sessionKey],
                        );
                        replacements.push({
                          entry: projected.entry,
                          previousSessionKeys,
                          sessionKey: primaryKey,
                        });
                        const cloned = labelOwners.replaceEntry(
                          candidateKeys,
                          primaryKey,
                          projected.entry,
                        );
                        projectedOutcomes.push({
                          ok: true,
                          entry: cloned,
                        });
                      } catch (error) {
                        projectedOutcomes.push({
                          ok: false,
                          error: unexpectedPatchError(target.key, error),
                        });
                      }
                    }
                    return { replacements, result: projectedOutcomes };
                  },
                });
                for (const [groupIndex, target] of group.entries()) {
                  outcomes[target.index] = groupOutcomes[groupIndex]!;
                }
              } catch (error) {
                for (const target of group) {
                  outcomes[target.index] = {
                    ok: false,
                    error: unexpectedPatchError(target.key, error),
                  };
                }
              }
            }),
          );
        },
      });
    } finally {
      for (const target of prepared) {
        try {
          target.archivePreparation?.drain.release();
        } catch (error) {
          sessionLog.warn(
            `sessions.patch: archive drain release failed for ${target.canonicalKey}: ${formatErrorMessage(error)}`,
          );
        }
      }
    }
  }

  let patched = false;
  const archivedSessionKeys = new Set<string>();
  for (const target of prepared) {
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
    persistSessionPatchModelSelection({
      cfg,
      callerScopes,
      entry: outcome.entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.targetAgentId,
    });
    emitSessionsChanged(params.context, {
      sessionKey: target.canonicalKey,
      ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
      reason: "patch",
    });
    patched = true;
    if (target.fullPatch.archived === true) {
      archivedSessionKeys.add(target.canonicalKey);
    }
  }

  const category = params.patch.category;
  if (patched && typeof category === "string" && category.trim()) {
    // A first-use category is a group-catalog mutation: clients reload the
    // catalog only on reason "groups" (the sessions.groups.* siblings emit it).
    if (ensureSessionGroupRegistered(category)) {
      emitSessionsChanged(params.context, { reason: "groups" });
    }
  }
  if (callerCanManageCron && archivedSessionKeys.size > 0) {
    try {
      const disabledBySession = await disableCronJobsBoundToSessions({
        cron: params.context.cron,
        cfg,
        sessionKeys: [...archivedSessionKeys],
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
    cfg,
    outcomes: outcomes as MutationOutcome[],
    preparedByIndex,
    modelCatalogByAgent,
  };
}

export async function executeSessionPatchMany(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  targets: readonly PatchTargetIdentity[];
}): Promise<
  { ok: false; error: ErrorShape } | { ok: true; outcomes: SessionsPatchManyResult["outcomes"] }
> {
  const executed = await executeSessionPatchMutations({
    client: params.client,
    context: params.context,
    patch: params.patch,
    targets: params.targets.map((target) => ({
      ...target,
      commitGuard: createCommitGuard(target.key.trim(), () =>
        params.sessionMutationAuthorization?.assertTargetCurrent({
          sessionKey: target.key.trim(),
          ...(target.agentId ? { agentId: target.agentId } : {}),
        }),
      ),
    })),
  });
  if (!executed.ok) {
    return executed;
  }
  const outcomes: SessionsPatchManyResult["outcomes"] = [];
  for (const [index, outcome] of executed.outcomes.entries()) {
    const target = params.targets[index]!;
    if (outcome.ok) {
      outcomes.push(
        target.agentId
          ? { ok: true, key: target.key, agentId: target.agentId }
          : { ok: true, key: target.key },
      );
      continue;
    }
    outcomes.push(
      target.agentId
        ? { ok: false, key: target.key, agentId: target.agentId, error: outcome.error }
        : { ok: false, key: target.key, error: outcome.error },
    );
  }
  return { ok: true, outcomes };
}

export async function executeSessionPatch(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: SessionsPatchParams;
  sessionMutationAuthorization?: SessionMutationAuthorization;
}): Promise<{ ok: false; error: ErrorShape } | { ok: true; result: SessionsPatchResult }> {
  const target = {
    key: params.patch.key,
    ...(params.patch.agentId ? { agentId: params.patch.agentId } : {}),
    ...(params.patch.expectedSessionId !== undefined
      ? { expectedSessionId: params.patch.expectedSessionId }
      : {}),
    ...(params.patch.expectedLifecycleRevision !== undefined
      ? { expectedLifecycleRevision: params.patch.expectedLifecycleRevision }
      : {}),
  };
  const executed = await executeSessionPatchMutations({
    client: params.client,
    context: params.context,
    patch: params.patch,
    targets: [
      {
        ...target,
        commitGuard: createCommitGuard(
          target.key,
          params.sessionMutationAuthorization?.assertCurrent,
        ),
      },
    ],
  });
  if (!executed.ok) {
    return executed;
  }
  const outcome = executed.outcomes[0]!;
  if (!outcome.ok) {
    return outcome;
  }
  const prepared = executed.preparedByIndex[0]!;
  return {
    ok: true,
    result: await projectSessionPatchResult({
      canonicalKey: prepared.canonicalKey,
      cfg: executed.cfg,
      entry: outcome.entry,
      modelCatalogByAgent: executed.modelCatalogByAgent,
      storePath: prepared.storePath,
      targetAgentId: prepared.targetAgentId,
    }),
  };
}
