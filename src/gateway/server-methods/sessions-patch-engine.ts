import type {
  ErrorShape,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isInternalSessionEffectsKey } from "../../config/sessions/internal-session-key.js";
import {
  assertLifecycleTargetSnapshotUnchanged,
  type SqliteLifecycleTargetSnapshot,
} from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import {
  applySessionEntryCanonicalReplacements,
  type SessionEntryCanonicalReplacement,
} from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { SessionLabelOwnerIndex } from "../../config/sessions/session-entry-selection.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { parseSessionLabel } from "../../sessions/session-label.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  resolveCanonicalGatewaySessionStoreKey,
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
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
import {
  createSessionPatchCatalogPreparation,
  type SessionPatchCatalogResult,
} from "./sessions-patch-catalog-preparation.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";
import { publishSessionPatchEffects } from "./sessions-patch-effects.js";
import {
  invalidSessionPatchOutcome,
  sessionChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import * as sessionPatchExpectations from "./sessions-patch-expectations.js";
import type { ActiveSessionPermissionChange } from "./sessions-patch-permissions.runtime.js";
import { resolveSessionWorkerPlacementPatchError } from "./sessions-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { preparePersonalModelSelection } from "./users-model-account-access.js";

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
  | {
      ok: true;
      applied: boolean;
      accessChanged: boolean;
      entry: SessionEntry;
      cleanupError?: ErrorShape;
    }
  | { ok: false; error: ErrorShape };

type WorktreeTransition = Awaited<ReturnType<typeof prepareSessionPatchWorktreeTransition>>;
type GroupMutationOperation = {
  replacements?: SessionEntryCanonicalReplacement[];
  result: GroupMutationResult;
};

type GroupMutationResult =
  | { kind: "model-catalog" }
  | { kind: "complete"; outcomes: MutationOutcome[] };

type MutationCoreResult =
  | { ok: false; error: ErrorShape }
  | {
      ok: true;
      cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
      outcomes: MutationOutcome[];
      preparedByIndex: Array<PreparedPatchTarget | undefined>;
      catalogs: ReturnType<typeof createSessionPatchCatalogPreparation>;
    };

export async function executeSessionPatchMutations(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  diagnostics?: SessionPatchDiagnostics;
  patch: Omit<SessionsPatchParams, keyof PatchTargetIdentity>;
  targets: readonly MutationTarget[];
}): Promise<MutationCoreResult> {
  const { client } = params;
  const timing = params.diagnostics?.scope("preflight");
  let personalModelSelection: UserModelAccountSelection | undefined;
  try {
    personalModelSelection = preparePersonalModelSelection(params, params.patch.model);
  } catch (error) {
    return { ok: false, error: unexpectedPatchError(params.targets[0]?.key ?? "", error) };
  }
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
      return invalidSessionPatchOutcome("Duplicate target.");
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
      outcomes[index] = invalidSessionPatchOutcome(unreadAckError);
      continue;
    }
    if (!requestedAgent.ok) {
      outcomes[index] = requestedAgent;
      continue;
    }
    if (!resolved) {
      outcomes[index] = invalidSessionPatchOutcome("Session target could not be resolved.");
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
      outcomes[index] = invalidSessionPatchOutcome(missingHarnessSessionError);
      continue;
    }
    // Commit guards are core control state; construct the protocol patch from
    // its public identity fields so closures can never reach hooks or entries.
    const { commitGuard: _commitGuard, ...identity } = input;
    const fullPatch: SessionsPatchParams = { ...params.patch, ...identity };
    const expectationError =
      sessionPatchExpectations.resolveSessionPatchExpectationError(fullPatch);
    if (expectationError) {
      outcomes[index] = invalidSessionPatchOutcome(expectationError);
      continue;
    }
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
      outcomes[index] = invalidSessionPatchOutcome(initialPlacementPatchError);
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

  const catalogs = createSessionPatchCatalogPreparation(
    (agentId) => params.context.loadGatewayModelCatalog({ agentId }),
    params.diagnostics,
  );

  if (prepared.length > 0) {
    const releaseArchiveDrains = async () =>
      prepared.forEach((target) => releaseSessionPatchArchive(target.archivePreparation));
    try {
      // Cloud reclaim precedes every mutation mutex; an earlier Move may need one.
      timing?.mark("archive");
      await Promise.all(
        prepared
          .filter((target) => target.fullPatch.archived === true)
          .map(async (target) => {
            try {
              const result = await prepareSessionPatchArchive({
                cfg,
                commitGuard: params.targets[target.index]!.commitGuard,
                context: params.context,
                loadGatewayModelCatalog: () => catalogs.load(target.targetAgentId),
                personalModelSelection,
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
      timing?.mark("lifecycleAdmission");
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
          timing?.mark();
          try {
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
                const groupTiming = params.diagnostics?.scope("snapshot");
                try {
                  // Keep every resolver candidate for queued alias revalidation. Label
                  // uniqueness needs only the requested label's owners, not the full store.
                  const selectedSessionKeys = group.flatMap((target) => [
                    target.key,
                    target.canonicalKey,
                    ...target.initialStoreKeys,
                  ]);
                  const requestedLabel = parseSessionLabel(first.fullPatch.label);
                  const worktreeTransitions = new Map<number, WorktreeTransition>();
                  const commitGuards = new Set<() => ErrorShape | undefined>();
                  const projectGroup = async (
                    entries: SqliteLifecycleTargetSnapshot,
                    catalogPreparation?: SessionPatchCatalogResult,
                  ): Promise<GroupMutationOperation> => {
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
                        // Compare tool policy against the captured snapshot; the final
                        // commit rejects a selection changed during preparation.
                        const expectedSessionChanged =
                          (target.fullPatch.expectedSessionId !== undefined &&
                            existingEntry?.sessionId !== target.fullPatch.expectedSessionId) ||
                          (target.fullPatch.expectedLifecycleRevision !== undefined &&
                            existingEntry?.lifecycleRevision !==
                              target.fullPatch.expectedLifecycleRevision) ||
                          sessionPatchExpectations.sessionPatchExpectationsChanged(
                            existingEntry,
                            target.fullPatch,
                          );
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
                            projectedOutcomes.push({ ok: false, error: archiveError });
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
                            accessChanged: false,
                            entry: unreadAck.entry,
                          });
                          continue;
                        }
                        const projection = await catalogs.project({
                          agentId: target.targetAgentId,
                          // Multi-target groups retain ordered effects and label claims.
                          mode: group.length === 1 ? "prepare" : "ordered",
                          catalog: catalogPreparation,
                          projection: {
                            cfg,
                            creation,
                            existingEntry,
                            isLabelInUse: (label) => labelOwners.isLabelInUse(label, candidateKeys),
                            storeKey: primaryKey,
                            agentId: target.requestedAgentId,
                            patch: target.fullPatch,
                            archivedBy: archiveActor,
                            personalModelSelection,
                          },
                        });
                        if (projection.kind === "model-catalog") {
                          // No replacements or runtime effects exist yet. Release this
                          // writer snapshot; completed preparation must use fresh rows.
                          return { result: projection };
                        }
                        const projected = projection.result;
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
                          projectedOutcomes.push(invalidSessionPatchOutcome(placementPatchError));
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
                          const worktreeTiming = params.diagnostics?.scope("worktree");
                          let transition: WorktreeTransition;
                          try {
                            transition = await prepareSessionPatchWorktreeTransition({
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
                          } finally {
                            worktreeTiming?.finish();
                          }
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
                        commitGuards.add(params.targets[target.index]!.commitGuard);
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
                          // The replacement writer validates this row snapshot at COMMIT.
                          // Unknown generations and canonical moves still invalidate access.
                          accessChanged:
                            primaryKey !== target.canonicalKey ||
                            previousSessionKeys.length > 0 ||
                            hasSessionReadAccessChanged(existingEntry, projected.entry),
                          entry: cloned,
                        });
                      } catch (error) {
                        projectedOutcomes.push({
                          ok: false,
                          error: unexpectedPatchError(target.key, error),
                        });
                      }
                    }
                    return {
                      replacements,
                      result: { kind: "complete", outcomes: projectedOutcomes },
                    };
                  };
                  const groupStore = {
                    assertCommitAllowed: () => {
                      // Fresh selections remain human-owned through the final commit;
                      // existing session pins are intentionally not rebound to the caller.
                      personalModelSelection?.assertCurrent();
                      for (const guard of commitGuards) {
                        const error = guard();
                        if (error) {
                          throw new SessionMutationAuthorizationChangedError(error);
                        }
                      }
                      for (const transition of worktreeTransitions.values()) {
                        transition.assertCommitAllowed();
                      }
                    },
                    agentId: first.targetAgentId,
                    sessionKeys: selectedSessionKeys,
                    ...(requestedLabel.ok ? { includeLabelOwners: requestedLabel.label } : {}),
                    storePath: first.storePath,
                    skipMaintenance: true,
                  };
                  const readGroup = () =>
                    applySessionEntryCanonicalReplacements({
                      ...groupStore,
                      update: (entries) => ({ result: entries }),
                    });
                  let snapshot = await readGroup();
                  // Preserve ordered label and runtime decisions without holding the
                  // agent writer across catalog, allocation, or filesystem preparation.
                  groupTiming?.mark("projection");
                  let operation = await projectGroup(snapshot);
                  if (operation.result.kind === "model-catalog") {
                    groupTiming?.mark();
                    const catalog = await catalogs.prepare(first.targetAgentId);
                    groupTiming?.mark("snapshot");
                    snapshot = await readGroup();
                    groupTiming?.mark("projection");
                    operation = await projectGroup(snapshot, catalog);
                  }
                  const { replacements, result } = operation;
                  if (result.kind !== "complete") {
                    throw new Error("Session patch catalog preparation did not complete");
                  }
                  groupTiming?.mark("commit");
                  const groupOutcomes = replacements?.length
                    ? await applySessionEntryCanonicalReplacements({
                        ...groupStore,
                        update: (entries) => {
                          // Async preparation owns detached rows, not permission to overwrite
                          // a changed target, alias, or requested-label owner.
                          assertLifecycleTargetSnapshotUnchanged(
                            snapshot,
                            entries,
                            "session patch",
                          );
                          return { replacements, result: result.outcomes };
                        },
                      })
                    : result.outcomes;
                  for (const [groupIndex, target] of group.entries()) {
                    const outcome = groupOutcomes[groupIndex]!;
                    outcomes[target.index] = outcome;
                    const afterCommit = worktreeTransitions.get(target.index)?.afterCommit;
                    if (outcome.ok && outcome.applied && afterCommit) {
                      groupTiming?.mark("worktreeCleanup");
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
                } finally {
                  groupTiming?.finish();
                }
              }),
            );
            // Keep runtime acknowledgement in the mutation lane. A second browser
            // must not persist a newer mode and then have this older update win.
            timing?.mark("permissions");
            for (const target of prepared) {
              const outcome = outcomes[target.index];
              if (!target.permissionChange || !outcome?.ok || !outcome.applied) {
                continue;
              }
              const error = await target.permissionChange.apply(
                outcome.entry.permissionMode ?? null,
              );
              if (error) {
                permissionErrors.set(target.index, error);
              }
            }
          } finally {
            timing?.mark("lifecycleFinalize");
          }
        },
      });
    } finally {
      timing?.mark("cleanup");
      for (const target of prepared) {
        target.permissionChange?.finish();
      }
      await releaseArchiveDrains();
    }
  }

  timing?.mark("effects");
  await publishSessionPatchEffects({
    cfg,
    context: params.context,
    callerScopes,
    callerCanManageCron,
    category: params.patch.category,
    targets: prepared.flatMap((target) => {
      const outcome = outcomes[target.index];
      return outcome?.ok && outcome.applied
        ? [{ target, entry: outcome.entry, accessChanged: outcome.accessChanged }]
        : [];
    }),
  });
  timing?.finish();

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
    catalogs,
  };
}
