import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchManyResult,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import {
  applySessionEntryCanonicalReplacements,
  type SessionEntryCanonicalReplacement,
} from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { SessionLabelOwnerIndex } from "../../config/sessions/session-entry-selection.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { projectSessionPatchResult } from "../session-utils-model.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
  type SessionsPatchResult,
} from "../session-utils.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import * as sessionUnreadAck from "./session-unread-ack.js";
import {
  prepareSessionPatchArchive,
  prepareSessionPatchWorktreeTransition,
  releaseSessionPatchArchive,
  type SessionPatchArchivePreparation,
  type SessionPatchArchiveTarget,
  validateSessionPatchArchiveProjection,
} from "./sessions-patch-archive.js";
import { publishSessionPatchEffects } from "./sessions-patch-effects.js";
import {
  createCommitGuard,
  sessionChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import type { ActiveSessionPermissionChange } from "./sessions-patch-permissions.runtime.js";
import { resolveSessionWorkerPlacementPatchError } from "./sessions-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./types.js";

type PatchTargetIdentity = sessionUnreadAck.SessionPatchTargetIdentity;
const { resolveSessionUnreadAck, validateSessionUnreadAck } = sessionUnreadAck;

type MutationTarget = PatchTargetIdentity & {
  commitGuard: () => ErrorShape | undefined;
};

type PreparedPatchTarget = SessionPatchArchiveTarget & {
  archivePreparation?: SessionPatchArchivePreparation;
  index: number;
  targetAgentId: string;
  permissionChange?: ActiveSessionPermissionChange;
};

type MutationOutcome =
  | { ok: true; applied: boolean; entry: SessionEntry; cleanupError?: ErrorShape }
  | { ok: false; error: ErrorShape };

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

async function executeSessionPatchMutations(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  targets: readonly MutationTarget[];
}): Promise<MutationCoreResult> {
  const { client } = params;
  const cfg = params.context.getRuntimeConfig();
  const operatorCreation = resolveOperatorSessionCreation(client);
  const sandbox = resolveCreatorSandbox(cfg, operatorCreation);
  const creation = { ...operatorCreation, ...(sandbox ? { sandbox } : {}) };
  const archiveActor = gatewayClientSessionCreator(client);
  const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const callerCanManageCron = client === null || callerScopes.includes(ADMIN_SCOPE);
  const pluginOwnerId = client?.internal?.pluginRuntimeOwnerId;
  const permissionRuntime =
    "permissionMode" in params.patch
      ? await import("./sessions-patch-permissions.runtime.js")
      : undefined;
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
  const permissionErrors = new Map<number, ErrorShape>();
  const prepared: PreparedPatchTarget[] = [];
  const preparedByIndex = Array.from<PreparedPatchTarget | undefined>({
    length: params.targets.length,
  });
  for (const [index, { input, key, requestedAgent, resolved }] of preflightTargets.entries()) {
    const unreadAckError = validateSessionUnreadAck(params.patch, input);
    if (unreadAckError) {
      outcomes[index] = {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, unreadAckError),
      };
      continue;
    }
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
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: initialEntry,
      key: canonicalKey,
      pluginOwnerId,
    });
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
    const releaseArchiveDrains = async () =>
      prepared.forEach((target) => releaseSessionPatchArchive(target.archivePreparation));
    try {
      // Cloud reclaim precedes every mutation mutex; an earlier Move may need one.
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
      await runExclusiveSessionLifecycleMutation({
        targets: prepared.map((target) => ({
          scope: target.storePath,
          identities: target.lifecycleIdentities,
        })),
        prepare: async () => {
          for (const target of prepared) {
            target.archivePreparation?.drain.handoffToMutation();
          }
        },
        finalize: releaseArchiveDrains,
        run: async () => {
          const groups = new Map<string, PreparedPatchTarget[]>();
          for (const target of prepared) {
            if (target.fullPatch.archived === true && !target.archivePreparation) {
              continue;
            }
            const groupKey = `${target.storePath}\0${target.targetAgentId}`;
            const group = groups.get(groupKey) ?? [];
            group.push(target);
            groups.set(groupKey, group);
          }
          await Promise.all(
            [...groups.values()].map(async (group) => {
              const first = group[0]!;
              try {
                // Keep every resolver candidate for queued alias revalidation. Label
                // uniqueness needs only the requested label's owners, not the full store.
                const selectedSessionKeys = group.flatMap((target) => [
                  target.key,
                  target.canonicalKey,
                  ...target.initialStoreKeys,
                ]);
                const requestedLabel = parseSessionLabel(first.fullPatch.label);
                const worktreeTransitions = new Map<
                  number,
                  Awaited<ReturnType<typeof prepareSessionPatchWorktreeTransition>>
                >();
                const groupOutcomes = await applySessionEntryCanonicalReplacements({
                  assertCommitAllowed: () => {
                    for (const transition of worktreeTransitions.values()) {
                      transition.assertCommitAllowed();
                    }
                  },
                  agentId: first.targetAgentId,
                  sessionKeys: selectedSessionKeys,
                  ...(requestedLabel.ok ? { includeLabelOwners: requestedLabel.label } : {}),
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
                        const ownershipError = resolvePluginSessionOwnershipError({
                          action: "patch",
                          entry: existingEntry,
                          key: primaryKey,
                          pluginOwnerId,
                        });
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
                        const unreadAck = resolveSessionUnreadAck(existingEntry, target.fullPatch);
                        if (unreadAck.kind === "missing") {
                          projectedOutcomes.push({
                            ok: false,
                            error: sessionChangedError(target.key),
                          });
                          continue;
                        }
                        if (unreadAck.kind === "stale") {
                          const authorizationFailure = params.targets[target.index]!.commitGuard();
                          if (authorizationFailure) {
                            projectedOutcomes.push({ ok: false, error: authorizationFailure });
                            continue;
                          }
                          // A newer explicit marker owns the session until a later activation.
                          projectedOutcomes.push({
                            ok: true,
                            applied: false,
                            entry: unreadAck.entry,
                          });
                          continue;
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
                        if (
                          existingEntry?.worktree &&
                          typeof target.fullPatch.archived === "boolean"
                        ) {
                          const transition = await prepareSessionPatchWorktreeTransition({
                            archived: target.fullPatch.archived,
                            entry: existingEntry,
                            context: params.context,
                            scope: {
                              agentId: target.targetAgentId,
                              sessionKey: primaryKey,
                              storePath: target.storePath,
                            },
                            authorize: params.targets[target.index]!.commitGuard,
                            preparation: target.archivePreparation,
                          });
                          worktreeTransitions.set(target.index, transition);
                        }
                        if (permissionRuntime && existingEntry?.sessionId) {
                          const permission = permissionRuntime.prepareSessionPatchPermissionChange({
                            context: params.context,
                            sessionId: existingEntry.sessionId,
                            sessionKey: target.canonicalKey,
                            agentId: target.targetAgentId,
                            assertCurrent: params.targets[target.index]!.commitGuard,
                          });
                          if (!permission.ok) {
                            projectedOutcomes.push(permission);
                            continue;
                          }
                          target.permissionChange = permission.change;
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
                          applied: true,
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
                  const outcome = groupOutcomes[groupIndex]!;
                  outcomes[target.index] = outcome;
                  const afterCommit = worktreeTransitions.get(target.index)?.afterCommit;
                  if (outcome.ok && outcome.applied && afterCommit) {
                    outcome.cleanupError = await afterCommit(outcome.entry);
                  }
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
          // Keep runtime acknowledgement in the mutation lane. A second browser
          // must not persist a newer mode and then have this older update win.
          for (const target of prepared) {
            const outcome = outcomes[target.index];
            if (!target.permissionChange || !outcome?.ok || !outcome.applied) {
              continue;
            }
            const error = await target.permissionChange.apply(outcome.entry.permissionMode ?? null);
            if (error) {
              permissionErrors.set(target.index, error);
            }
          }
        },
      });
    } finally {
      for (const target of prepared) {
        target.permissionChange?.finish();
      }
      await releaseArchiveDrains();
    }
  }

  await publishSessionPatchEffects({
    cfg,
    context: params.context,
    callerScopes,
    callerCanManageCron,
    category: params.patch.category,
    targets: prepared.flatMap((target) => {
      const outcome = outcomes[target.index];
      return outcome?.ok && outcome.applied ? [{ target, entry: outcome.entry }] : [];
    }),
  });

  // Runtime application can fail after commit. Publish every saved field's
  // normal effects before returning the application error to the caller.
  for (const [index, error] of permissionErrors) {
    outcomes[index] = { ok: false, error };
  }
  return {
    ok: true,
    cfg,
    // Publish committed hooks/events/cron changes even when only checkout cleanup failed.
    outcomes: outcomes.map((outcome) =>
      outcome?.ok && outcome.cleanupError ? { ok: false, error: outcome.cleanupError } : outcome,
    ) as MutationOutcome[],
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
    expectedMarkedUnreadAt: params.patch.expectedMarkedUnreadAt,
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
