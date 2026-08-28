import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import type {
  InternalSessionEntry as SessionEntry,
  RestartRecoveryRun,
} from "../../config/sessions.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RestartRecoveryCandidate } from "../../gateway/chat-abort.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { listAgentRunsForSession } from "../../infra/agent-run-registry.js";
import {
  collectActiveSessionWorkAdmissions,
  isSessionWorkAdmissionTargetActive,
} from "../../sessions/session-lifecycle-admission.js";
import {
  listActiveEmbeddedRunSessionIds,
  listActiveEmbeddedRunSessionKeys,
} from "../embedded-agent-runner/run-state.js";
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

async function markRecoveryStore(params: {
  storePath: string;
  statuses?: Array<NonNullable<SessionEntry["status"]>>;
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
    | undefined;
}) {
  return await applySessionEntryReplacements<{ marked: number; skipped: number }>({
    storePath: params.storePath,
    statuses: params.statuses,
    requireWriteSuccess: true,
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
        counts.marked++;
      }
      return { result: counts, replacements };
    },
  });
}

export async function markRestartAbortedMainSessions(params: {
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
  const activeAdmissions = collectActiveSessionWorkAdmissions();
  if (activeRuns.length === 0 && activeAdmissions.size === 0) {
    return result;
  }

  const storePaths = new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
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

  for (const storePath of activeAdmissions.keys()) {
    storePaths.add(storePath);
  }
  for (const storePath of storePaths) {
    const storeResult = await markRecoveryStore({
      storePath,
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
        const matchedActiveAdmission = isSessionWorkAdmissionTargetActive({
          scope: storePath,
          sessionKey,
          sessionId: entry.sessionId,
        });
        if (matchingActiveRuns.length === 0 && !matchedActiveAdmission) {
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

  // Check each store path once at startup so rows added later in that same path remain current.
  // Add paths only after every marking write succeeds so a failed scan retries safely.
  const storePaths = (await resolveRestartRecoveryStorePaths(params)).filter(
    (storePath) => !params.startupCheckedStorePaths?.has(storePath),
  );
  for (const storePath of storePaths) {
    const storeResult = await markRecoveryStore({
      storePath,
      statuses: ["running"],
      plan: (entry, sessionKey) => {
        if (entry.status !== "running" || entry.abortedLastRun === true) {
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
        if (
          hasCurrentProcessOwner({
            activeSessionIds: resolveActiveSessionIds(),
            activeSessionKeys: resolveActiveSessionKeys(),
            entry,
            sessionKey,
          })
        ) {
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
