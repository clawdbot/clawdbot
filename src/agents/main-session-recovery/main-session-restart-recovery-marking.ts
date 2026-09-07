import { randomUUID } from "node:crypto";
import { resolveSessionStoreCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveStateDir } from "../../config/paths.js";
import type {
  InternalSessionEntry as SessionEntry,
  RestartRecoveryRun,
} from "../../config/sessions.js";
import {
  applySessionEntryReplacements,
  listSessionEntriesReadOnly,
} from "../../config/sessions/session-accessor.js";
import {
  listDurableSqliteTargetOwnersForSessionStorePath,
  resolveSqliteTargetFromSessionStorePath,
} from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartRecoveryCandidate } from "../../gateway/chat-abort.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { listAgentRunsForSession } from "../../infra/agent-run-registry.js";
import { LEGACY_IMPLICIT_AGENT_ID, parseAgentSessionKey } from "../../routing/session-key.js";
import { captureGatewaySessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import { appendInterruptedSessionTrajectoryEndSync } from "../../trajectory/interrupted-end.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../embedded-agent-runner/active-run-projections.js";
import {
  isMainRestartRecoveryAggregateTerminalOnly,
  isMainRestartRecoveryCandidate,
  normalizeMainSessionRecoveryRunFences,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";
import {
  discoverRestartRecoveryStorePaths,
  hasCurrentProcessOwner,
  mainSessionRecoveryLog,
  normalizeFiniteTimestamp,
  normalizeStringSet,
  resolveRestartRecoveryStorePaths,
} from "./main-session-restart-recovery-shared.js";
import { captureYieldedMainSessionContinuation } from "./main-session-restart-recovery-target.js";

function resolveInterruptedSessionOwner(params: {
  cfg: OpenClawConfig | undefined;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  // Global and legacy-alias keys in a fixed store are owned by the configured
  // compatibility agent (an explicit persisted owner or the legacy default).
  // Without config the store writer resolves those rows to the legacy implicit
  // owner. Agent-scoped keys already returned above, so this only applies to
  // unscoped keys.
  if (params.cfg) {
    return resolveSessionStoreCompatibilityAgentId(params.cfg);
  }
  return LEGACY_IMPLICIT_AGENT_ID;
}

async function markRecoveryStore(params: {
  storePath: string;
  sessionKey?: string;
  assertCommitAllowed?: () => void;
  statuses?: Array<NonNullable<SessionEntry["status"]>>;
  cfg?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  trajectoryReason?: string;
  plan: (
    entry: SessionEntry,
    sessionKey: string,
  ) =>
    | {
        action: "mark";
        forceRestartSafeTools?: boolean;
        replaceRuns?: boolean;
        resetRuntime?: boolean;
        runs?: RestartRecoveryRun[];
      }
    | { action: "retire_terminal" }
    | { action: "restore_yielded"; isCurrent: () => boolean }
    | undefined;
}) {
  // Fixed stores may partition rows across per-agent SQLite siblings. Scan each
  // durable owner so global/legacy-alias keys under an explicit compatibility
  // agent are processed in their own database, not silently dropped by the
  // default-owner resolution.
  const owners = listDurableSqliteTargetOwnersForSessionStorePath(params.storePath);
  const agentIdsToScan = owners.length > 0 ? owners : [undefined];
  const aggregated = { marked: 0, skipped: 0 };
  for (const ownerAgentId of agentIdsToScan) {
    // Resolve the trajectory database target for this owner partition before
    // opening the session write transaction so filesystem/registry inspection
    // does not run while the session lock is held.
    const trajectoryTarget = resolveSqliteTargetFromSessionStorePath(
      params.storePath,
      ownerAgentId ? { agentId: ownerAgentId } : {},
    );
    const yieldOwners: Array<() => boolean> = [];
    const markedSessions: Array<{
      sessionKey: string;
      sessionId: string;
      runId?: string;
      agentId?: string;
    }> = [];
    const groupResult = await applySessionEntryReplacements<{ marked: number; skipped: number }>({
      storePath: params.storePath,
      sessionKeys: params.sessionKey ? [params.sessionKey] : undefined,
      statuses: params.statuses,
      requireWriteSuccess: true,
      ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
      assertCommitAllowed: () => {
        params.assertCommitAllowed?.();
        if (yieldOwners.some((isCurrent) => !isCurrent())) {
          throw new Error("Yielded requester continuation changed before recovery handoff");
        }
      },
      update: (entries) => {
        const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
        const counts = { marked: 0, skipped: 0 };
        for (const { sessionKey, entry } of entries) {
          const plan = params.plan(entry, sessionKey);
          if (!plan) {
            continue;
          }
          if (!isMainRestartRecoveryCandidate(entry, sessionKey)) {
            counts.skipped++;
            continue;
          }
          if (plan.action === "restore_yielded") {
            yieldOwners.push(plan.isCurrent);
            transitionMainSessionRecovery(entry, { kind: "clear" });
            replacements.push({ sessionKey, entry });
            counts.skipped++;
            continue;
          }
          if (plan.action === "retire_terminal") {
            transitionMainSessionRecovery(entry, {
              kind: "observe",
              cycleId: randomUUID(),
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
              sessionKey,
            });
            replacements.push({ sessionKey, entry });
            counts.skipped++;
            continue;
          }
          const interruptedRunId = entry.lifecycleRunId;
          // The row was just committed in this scan's durable owner partition
          // (or the store's default-owner pass when no partition is recorded),
          // so the scanned owner is the authoritative trajectory owner; key and
          // config resolution only covers the unscanned default-owner pass.
          const sessionOwnerAgentId =
            ownerAgentId ?? resolveInterruptedSessionOwner({ cfg: params.cfg, sessionKey });
          if (plan.replaceRuns) {
            entry.restartRecoveryRuns = plan.runs;
          }
          if (plan.forceRestartSafeTools) {
            entry.restartRecoveryForceSafeTools = true;
          }
          transitionMainSessionRecovery(entry, {
            kind: "mark_interrupted",
            cycleId: randomUUID(),
            now: Date.now(),
            ...plan,
          });
          replacements.push({ sessionKey, entry });
          markedSessions.push({
            sessionKey,
            sessionId: entry.sessionId,
            runId: interruptedRunId,
            agentId: sessionOwnerAgentId,
          });
          counts.marked++;
        }
        return { result: counts, replacements };
      },
      afterWriteInTransaction: () => {
        for (const marked of markedSessions) {
          appendInterruptedSessionTrajectoryEndSync({
            agentDatabaseAgentId: trajectoryTarget.agentId ?? marked.agentId,
            agentDatabasePath: trajectoryTarget.path,
            env: params.env,
            runId: marked.runId,
            sessionKey: marked.sessionKey,
            sessionId: marked.sessionId,
            storePath: params.storePath,
            reason: params.trajectoryReason,
          });
        }
      },
    });
    aggregated.marked += groupResult.marked;
    aggregated.skipped += groupResult.skipped;
  }
  return aggregated;
}

export async function markRestartAbortedMainSessions(params: {
  resolveGatewayContext: GatewayContextResolver;
  cfg?: OpenClawConfig;
  additionalCfgs?: Iterable<OpenClawConfig | undefined>;
  stateDir?: string;
  activeRuns: Iterable<RestartRecoveryCandidate>;
  isActiveRun?: (run: RestartRecoveryCandidate) => boolean;
  reason?: string;
}): Promise<{ marked: number; skipped: number }> {
  const activeRuns = [...params.activeRuns];
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const result = { marked: 0, skipped: 0 };
  // Channel work can outlive its chat-run registration. The admission owner
  // retains the authoritative store and session identities until the turn releases.
  const activeAdmissions = captureGatewaySessionWorkAdmissions(params.resolveGatewayContext);
  if (activeRuns.length === 0 && activeAdmissions.targets.size === 0) {
    return result;
  }

  const storePaths = new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const configs = [params.cfg, ...(params.additionalCfgs ?? [])].filter(Boolean);
  for (const cfg of configs.length > 0 ? configs : [undefined]) {
    try {
      for (const storePath of await discoverRestartRecoveryStorePaths({ cfg, stateDir })) {
        storePaths.add(storePath);
      }
    } catch (err) {
      if (!cfg) {
        throw err;
      }
      mainSessionRecoveryLog.warn(
        `failed to resolve configured session stores for restart marker: ${String(err)}`,
      );
    }
  }

  for (const storePath of activeAdmissions.targets.keys()) {
    storePaths.add(storePath);
  }
  for (const storePath of storePaths) {
    // Preselect read-only: ID-only admissions can own multiple persisted keys.
    // The per-key replacement below rereads the row and revalidates its owner.
    // Fixed stores partition rows across per-agent SQLite siblings, so preselect
    // across every durable owner; the default-owner view alone can silently
    // drop a global row owned by a compatibility agent.
    const owners = listDurableSqliteTargetOwnersForSessionStorePath(storePath);
    const sessionKeys = [
      ...new Set(
        (owners.length > 0 ? owners : [undefined]).flatMap((ownerAgentId) =>
          listSessionEntriesReadOnly({
            ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
            storePath,
            projection: "list",
            clone: false,
          })
            .filter(
              ({ sessionKey, entry }) =>
                activeRuns.some(
                  (run) => run.sessionKey === sessionKey && run.sessionId === entry.sessionId,
                ) ||
                activeAdmissions.isActive({
                  scope: storePath,
                  sessionKey,
                  sessionId: entry.sessionId,
                }),
            )
            .map(({ sessionKey }) => sessionKey),
        ),
      ),
    ];
    for (const selectedSessionKey of sessionKeys) {
      let isCurrent: (() => boolean) | undefined;
      try {
        const storeResult = await markRecoveryStore({
          storePath,
          sessionKey: selectedSessionKey,
          cfg: params.cfg,
          env,
          trajectoryReason: params.reason,
          assertCommitAllowed: () => {
            if (isCurrent && !isCurrent()) {
              throw new Error("Restart recovery owner changed before commit");
            }
          },
          plan: (entry, sessionKey) => {
            // The shutdown owner supplies paired identities. Recheck ownership after
            // store discovery; an ID collision must not select a row or attach its fences.
            const matchingActiveRuns = activeRuns.filter(
              (run) =>
                run.sessionKey === sessionKey &&
                run.sessionId === entry.sessionId &&
                (entry.status === "running" ||
                  run.observedAt === undefined ||
                  normalizeFiniteTimestamp(entry.updatedAt) === undefined ||
                  (entry.updatedAt < run.observedAt &&
                    run.lifecycleGeneration !== currentLifecycleGeneration)) &&
                params.isActiveRun?.(run) !== false,
            );
            const matchedActiveAdmission = activeAdmissions.isActive({
              scope: storePath,
              sessionKey,
              sessionId: entry.sessionId,
            });
            if (matchingActiveRuns.length === 0 && !matchedActiveAdmission) {
              return undefined;
            }
            if (
              captureYieldedMainSessionContinuation({
                cfg: params.cfg,
                entry,
                sessionKey,
                storePath,
              })
            ) {
              return undefined;
            }
            const wasRunning = entry.status === "running";
            const runs = normalizeMainSessionRecoveryRunFences([
              ...(entry.restartRecoveryRuns ?? []).filter(
                (run) => run.lifecycleGeneration === currentLifecycleGeneration,
              ),
              ...listAgentRunsForSession({ sessionKey, sessionId: entry.sessionId }),
              ...matchingActiveRuns.map(({ runId, lifecycleGeneration }) => ({
                runId,
                lifecycleGeneration,
              })),
            ]);
            // Planning yields before SQLite commits. Revalidate the captured owners
            // in its synchronous guard, not just while selecting this row.
            isCurrent = () =>
              isAgentEventLifecycleGenerationCurrent(currentLifecycleGeneration) &&
              ((matchedActiveAdmission &&
                activeAdmissions.isActive({
                  scope: storePath,
                  sessionKey,
                  sessionId: entry.sessionId,
                })) ||
                matchingActiveRuns.some((run) => params.isActiveRun?.(run) !== false));
            return {
              action: "mark",
              forceRestartSafeTools: matchedActiveAdmission,
              replaceRuns: true,
              resetRuntime: !wasRunning,
              runs,
            };
          },
        });
        result.marked += storeResult.marked;
        result.skipped += storeResult.skipped;
      } catch (error) {
        assertAgentRunLifecycleGenerationCurrent(currentLifecycleGeneration);
        if (!isCurrent || isCurrent()) {
          throw error;
        }
        result.skipped++;
      }
    }
  }

  if (result.marked > 0) {
    mainSessionRecoveryLog.warn(
      `marked ${result.marked} interrupted main session(s) for restart recovery${
        params.reason ? ` (${params.reason})` : ""
      }`,
    );
  }
  return result;
}

export async function markStartupOrphanedMainSessionsForRecovery(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  startupCheckedStorePaths?: Set<string>;
  updatedBeforeMs?: number;
}): Promise<{ marked: number; skipped: number }> {
  const result = { marked: 0, skipped: 0 };
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const providedActiveSessionIds =
    params.activeSessionIds === undefined ? undefined : normalizeStringSet(params.activeSessionIds);
  const providedActiveSessionKeys =
    params.activeSessionKeys === undefined
      ? undefined
      : normalizeStringSet(params.activeSessionKeys);
  const updatedBeforeMs = normalizeFiniteTimestamp(params.updatedBeforeMs);
  // Lifecycle rotation synchronously evicts stale owners, so this same registry
  // view drives both operational routing and recovery suppression. Re-read it at
  // each check so a newer owner can still fence an older async recovery scan.
  const resolveActiveSessionIds = () =>
    providedActiveSessionIds ?? normalizeStringSet(listActiveEmbeddedRunSessionIds());
  const resolveActiveSessionKeys = () =>
    providedActiveSessionKeys ?? normalizeStringSet(listActiveEmbeddedRunSessionKeys());
  const env =
    params.stateDir === undefined
      ? process.env
      : { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };

  // Check each store path once at startup so rows added later in that same path remain current.
  // Add paths only after every marking write succeeds so a failed scan retries safely.
  // Startup marking scans all durable owners internally, so we only need distinct paths here.
  const storePaths = new Set<string>();
  const recoveryTargets = (await resolveRestartRecoveryStorePaths(params)).filter((target) => {
    if (
      params.startupCheckedStorePaths?.has(target.storePath) ||
      storePaths.has(target.storePath)
    ) {
      return false;
    }
    storePaths.add(target.storePath);
    return true;
  });
  for (const target of recoveryTargets) {
    const storeResult = await markRecoveryStore({
      storePath: target.storePath,
      statuses: ["running"],
      cfg: params.cfg,
      env,
      assertCommitAllowed: () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
      plan: (entry, sessionKey) => {
        if (entry.status !== "running") {
          return undefined;
        }
        const updatedAt = normalizeFiniteTimestamp(entry.updatedAt);
        if (
          updatedBeforeMs !== undefined &&
          updatedAt !== undefined &&
          updatedAt > updatedBeforeMs
        ) {
          return undefined;
        }
        const hasLiveOwner = () =>
          hasCurrentProcessOwner({
            activeSessionIds: resolveActiveSessionIds(),
            activeSessionKeys: resolveActiveSessionKeys(),
            entry,
            sessionKey,
          });
        if (hasLiveOwner()) {
          return undefined;
        }
        const continuation = captureYieldedMainSessionContinuation({
          cfg: params.cfg,
          entry,
          sessionKey,
          storePath: target.storePath,
        });
        if (continuation) {
          // A newer foreground start clears endedAt. Only an unclaimed waiting cycle
          // may hand its interruption marker back to the exact durable child batch.
          const state = entry.mainRestartRecovery;
          if (
            entry.abortedLastRun === true &&
            !state?.reservation &&
            !state?.foregroundClaims &&
            !state?.tombstone &&
            !entry.restartRecoveryDeliveryRunId
          ) {
            return {
              action: "restore_yielded",
              isCurrent: () => continuation() && !hasLiveOwner(),
            };
          }
          return undefined;
        }
        if (entry.abortedLastRun === true) {
          return undefined;
        }
        return isMainRestartRecoveryAggregateTerminalOnly(entry)
          ? { action: "retire_terminal" }
          : { action: "mark" };
      },
    });
    result.marked += storeResult.marked;
    result.skipped += storeResult.skipped;
  }
  storePaths.forEach((storePath) => params.startupCheckedStorePaths?.add(storePath));

  if (result.marked > 0) {
    mainSessionRecoveryLog.warn(
      `marked ${result.marked} startup-orphaned main session(s) for restart recovery`,
    );
  }
  return result;
}
