/** Controller-authorized subagent list, kill, steer, and message operations. */
import crypto from "node:crypto";
import type { ClearSessionQueueResult } from "../auto-reply/reply/queue.js";
import { resolveSubagentLabel, sortSubagentRuns } from "../auto-reply/reply/subagents-utils.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type DetachedTaskTerminalState,
} from "../tasks/detached-task-runtime-contract.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";
import { resolveStoredSubagentCapabilities } from "./subagent-capabilities.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { resolveSessionEntryForKey } from "./subagent-list.js";
import {
  resolveFinalizedSubagentTaskState,
  resolveKilledSubagentTaskEndedAt,
} from "./subagent-registry-completion.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import {
  claimSubagentRunKill,
  clearSubagentRunSteerRestart,
  countPendingDescendantRuns,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  releaseSubagentRunKillClaim,
  replaceSubagentRunAfterSteer,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { terminateAcceptedCollectorRun } from "./subagent-spawn-cleanup.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

/** Recent-run default window used by subagent control UI/tools. */
export const DEFAULT_RECENT_MINUTES = 30;
/** Maximum recent-run window accepted by subagent control UI/tools. */
export const MAX_RECENT_MINUTES = 24 * 60;
const STEER_RATE_LIMIT_MS = 2_000;
const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;
const SUBAGENT_REPLY_HISTORY_LIMIT = 50;

const steerRateLimit = new Map<string, number>();

type GatewayCaller = typeof callGateway;
type PatchSessionEntry = typeof patchSessionEntry;
type AbortEmbeddedAgentRun = (sessionId: string) => boolean;
type IsEmbeddedAgentRunActive = (sessionId: string) => boolean;
type ClearSessionQueues = (keys: Array<string | undefined>) => ClearSessionQueueResult;

const defaultSubagentControlDeps = {
  callGateway,
  patchSessionEntry,
};

let subagentControlDeps: {
  callGateway: GatewayCaller;
  patchSessionEntry: PatchSessionEntry;
  abortEmbeddedAgentRun?: AbortEmbeddedAgentRun;
  isEmbeddedAgentRunActive?: IsEmbeddedAgentRunActive;
  clearSessionQueues?: ClearSessionQueues;
} = defaultSubagentControlDeps;

const subagentControlRuntimeLoader = createLazyImportLoader(
  () => import("./subagent-control.runtime.js"),
);

function loadSubagentControlRuntime() {
  return subagentControlRuntimeLoader.load();
}

async function resolveSubagentControlRuntime(): Promise<{
  abortEmbeddedAgentRun: AbortEmbeddedAgentRun;
  isEmbeddedAgentRunActive: IsEmbeddedAgentRunActive;
  clearSessionQueues: ClearSessionQueues;
}> {
  if (
    subagentControlDeps.abortEmbeddedAgentRun &&
    subagentControlDeps.isEmbeddedAgentRunActive &&
    subagentControlDeps.clearSessionQueues
  ) {
    return {
      abortEmbeddedAgentRun: subagentControlDeps.abortEmbeddedAgentRun,
      isEmbeddedAgentRunActive: subagentControlDeps.isEmbeddedAgentRunActive,
      clearSessionQueues: subagentControlDeps.clearSessionQueues,
    };
  }
  const runtime = await loadSubagentControlRuntime();
  return {
    abortEmbeddedAgentRun:
      subagentControlDeps.abortEmbeddedAgentRun ?? runtime.abortEmbeddedAgentRun,
    isEmbeddedAgentRunActive:
      subagentControlDeps.isEmbeddedAgentRunActive ?? runtime.isEmbeddedAgentRunActive,
    clearSessionQueues: subagentControlDeps.clearSessionQueues ?? runtime.clearSessionQueues,
  };
}

/** Controller identity and capability scope resolved from the caller session. */
export type ResolvedSubagentController = {
  controllerSessionKey: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};
/** Resolves which subagent runs the caller is allowed to control. */
export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
}): ResolvedSubagentController {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    key: callerRaw,
    alias,
    mainKey,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      controllerSessionKey: callerSessionKey,
      callerSessionKey,
      callerIsSubagent: false,
      controlScope: "children",
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(callerSessionKey, {
    cfg: params.cfg,
  });
  return {
    controllerSessionKey: callerSessionKey,
    callerSessionKey,
    callerIsSubagent: true,
    controlScope: capabilities.controlScope,
  };
}

function isSubagentRunVisibleToSession(entry: SubagentRunRecord, sessionKey: string): boolean {
  const controllerKey = entry.controllerSessionKey?.trim();
  const requesterKey = entry.requesterSessionKey.trim();
  // Completion routing can target a different session than control ownership.
  // Both owners may read the run, while ensureControllerOwnsRun still gates mutations.
  return controllerKey === sessionKey || requesterKey === sessionKey;
}

/** Builds one stable snapshot for controlled-run listing and descendant status reads. */
export function buildControlledSubagentRunsReadContext(controllerSessionKey: string): {
  runs: SubagentRunRecord[];
  countPendingDescendantRuns(rootSessionKey: string): number;
} {
  const key = controllerSessionKey.trim();
  if (!key) {
    return {
      runs: [],
      countPendingDescendantRuns: () => 0,
    };
  }

  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const readIndex = buildSubagentRunReadIndexFromRuns({ runs: snapshot });
  const filtered = Array.from(readIndex.latestRunsByChildSessionKey.values()).filter((entry) =>
    isSubagentRunVisibleToSession(entry, key),
  );
  return {
    runs: sortSubagentRuns(filtered),
    countPendingDescendantRuns: (rootSessionKey) =>
      readIndex.countPendingDescendantRuns(rootSessionKey),
  };
}

/** Lists latest child runs controlled by a session key. */
export function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[] {
  return buildControlledSubagentRunsReadContext(controllerSessionKey).runs;
}

function ensureControllerOwnsRun(params: {
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const owner = params.entry.controllerSessionKey?.trim() || params.entry.requesterSessionKey;
  if (owner === params.controller.controllerSessionKey) {
    return undefined;
  }
  return "Subagents can only control runs spawned from their own session.";
}

function isFinishedForSteerControl(entry: SubagentRunRecord, hasPendingDescendants: boolean) {
  return (
    Boolean(entry.execution.endedAt) &&
    entry.pauseReason !== "sessions_yield" &&
    !hasPendingDescendants
  );
}

function isCurrentSubagentRun(entry: SubagentRunRecord): boolean {
  return getLatestLiveSubagentRunByChildSessionKey(entry.childSessionKey) === entry;
}

function isSameSubagentRunGeneration(
  live: SubagentRunRecord,
  snapshot: SubagentRunRecord,
): boolean {
  return (
    live.childSessionKey === snapshot.childSessionKey &&
    live.runId === snapshot.runId &&
    live.generation === snapshot.generation &&
    live.createdAt === snapshot.createdAt
  );
}

type SubagentKillTargetState =
  | { state: "finalizing" }
  | { state: "terminal"; task: DetachedTaskTerminalState };

function resolveSubagentKillTargetState(
  entry: SubagentRunRecord,
): SubagentKillTargetState | undefined {
  if (
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.suppressAnnounceReason !== "steer-restart"
  ) {
    const taskEndedAt = resolveKilledSubagentTaskEndedAt(entry);
    return typeof taskEndedAt === "number"
      ? {
          state: "terminal",
          task: {
            status: "cancelled",
            endedAt: taskEndedAt,
            lastEventAt: taskEndedAt,
            error: SUBAGENT_KILL_TASK_ERROR,
            progressSummary: entry.completion?.resultText ?? undefined,
            terminalSummary: null,
          },
        }
      : undefined;
  }
  const terminal = resolveFinalizedSubagentTaskState(entry);
  if (terminal) {
    return { state: "terminal", task: terminal };
  }
  return typeof entry.execution.endedAt === "number" &&
    entry.pauseReason !== "sessions_yield" &&
    (entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
      entry.suppressAnnounceReason === "steer-restart")
    ? { state: "finalizing" }
    : undefined;
}

async function persistSubagentAbortedLastRun(params: {
  childSessionKey: string;
  storePath: string;
  hasSessionEntry: boolean;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  abortedLastRun: boolean;
  isCurrent?: (current: SessionEntry) => boolean;
  assertCommitAllowed?: () => void;
  strict?: boolean;
}): Promise<boolean> {
  if (!params.hasSessionEntry) {
    return true;
  }
  try {
    await subagentControlDeps.patchSessionEntry(
      { storePath: params.storePath, sessionKey: params.childSessionKey },
      (current) =>
        current.sessionId !== params.expectedSessionId ||
        current.lifecycleRevision !== params.expectedLifecycleRevision ||
        params.isCurrent?.(current) === false
          ? null
          : {
              ...current,
              abortedLastRun: params.abortedLastRun,
              updatedAt: Date.now(),
            },
      {
        assertCommitAllowed: params.assertCommitAllowed,
        replaceEntry: true,
      },
    );
    return true;
  } catch (error) {
    if (params.strict) {
      throw error;
    }
    logVerbose(
      `subagents control kill: failed to persist abortedLastRun=${params.abortedLastRun} for ${params.childSessionKey}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

function markSubagentRunTerminatedBestEffort(
  params: Parameters<typeof markSubagentRunTerminated>[0],
): number {
  try {
    return markSubagentRunTerminated(params);
  } catch (error) {
    // The registry transition rolled back atomically. Keep multi-run control
    // moving so one persistence failure cannot leave siblings running.
    logVerbose(
      `subagents control kill: failed to persist ${params.runId ?? params.childSessionKey ?? "unknown"}: ${formatErrorMessage(error)}`,
    );
    return 0;
  }
}

async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
  suppressTaskDelivery?: boolean;
}): Promise<{
  killed: boolean;
  sessionId?: string;
  superseded?: boolean;
  targetState?: SubagentKillTargetState;
  error?: string;
}> {
  const markKilledBestEffort = () =>
    markSubagentRunTerminatedBestEffort({
      runId: params.entry.runId,
      reason: "killed",
      suppressTaskDelivery: params.suppressTaskDelivery,
    });
  const initialTargetState = resolveSubagentKillTargetState(params.entry);
  if (initialTargetState) {
    if (
      params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      params.entry.suppressAnnounceReason !== "steer-restart"
    ) {
      markKilledBestEffort();
    }
    return { killed: false, targetState: initialTargetState };
  }
  if (params.entry.execution.endedAt && params.entry.pauseReason !== "sessions_yield") {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const sessionLifecycleRevision = resolved.entry?.lifecycleRevision;
  const runtime = await resolveSubagentControlRuntime();
  let admittedWorkReleased = true;
  return await runExclusiveSessionLifecycleMutation({
    scope: resolved.storePath,
    identities: [childSessionKey, sessionId],
    prepare: async () => {
      if (!isCurrentSubagentRun(params.entry)) {
        return;
      }
      admittedWorkReleased = await interruptSessionWorkAdmissions({
        scope: resolved.storePath,
        identities: [childSessionKey, sessionId],
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
    },
    run: async () => {
      if (!admittedWorkReleased) {
        return {
          killed: false,
          sessionId,
          error: "Subagent is still active; try the kill again in a moment.",
        };
      }
      // Runtime loading and admission draining yield. Fence the exact row before
      // touching session-owned queues so a successor cannot inherit an older kill.
      if (!isCurrentSubagentRun(params.entry)) {
        return { killed: false, sessionId, superseded: true };
      }
      const targetStateAfterRuntimeLoad = resolveSubagentKillTargetState(params.entry);
      if (targetStateAfterRuntimeLoad) {
        if (
          params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
          params.entry.suppressAnnounceReason !== "steer-restart"
        ) {
          markKilledBestEffort();
        }
        return { killed: false, sessionId, targetState: targetStateAfterRuntimeLoad };
      }
      let killClaim: ReturnType<typeof claimSubagentRunKill>;
      const killOwnerCurrent = () =>
        isCurrentSubagentRun(params.entry) &&
        (!killClaim ||
          ((params.entry.killIntent === killClaim ||
            (params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
              params.entry.killReconciliation !== undefined &&
              params.entry.execution.lifecycleGeneration === killClaim.lifecycleGeneration)) &&
            (killClaim.lifecycleGeneration === undefined ||
              isAgentEventLifecycleGenerationCurrent(killClaim.lifecycleGeneration))));
      const persistAbortedLastRun = (abortedLastRun: boolean, strict = false) =>
        persistSubagentAbortedLastRun({
          childSessionKey,
          storePath: resolved.storePath,
          hasSessionEntry: resolved.entry !== undefined,
          expectedSessionId: sessionId,
          expectedLifecycleRevision: sessionLifecycleRevision,
          abortedLastRun,
          isCurrent: () => killOwnerCurrent(),
          assertCommitAllowed: () => {
            if (!killOwnerCurrent()) {
              throw new Error("subagent kill lifecycle retired before abort-marker commit");
            }
          },
          strict,
        });
      try {
        // Persist operator intent before aborting runtime work. If terminal
        // persistence fails, recovery still cannot replay this exact row.
        killClaim = claimSubagentRunKill({
          runId: params.entry.runId,
          expected: params.entry,
          sessionId,
          sessionLifecycleRevision,
          suppressTaskDelivery: params.suppressTaskDelivery,
        });
      } catch (error) {
        return {
          killed: false,
          sessionId,
          error: `Failed to persist subagent kill intent: ${formatErrorMessage(error)}`,
        };
      }
      if (!killClaim || !killOwnerCurrent()) {
        return {
          killed: false,
          sessionId,
          superseded: true,
        };
      }
      const claimedKill = killClaim;
      const ownsSessionIncarnation = () => {
        const currentSessionEntry = loadSessionEntry({
          storePath: resolved.storePath,
          sessionKey: childSessionKey,
          clone: false,
          readConsistency: "latest",
        });
        return (
          (currentSessionEntry !== undefined) === (resolved.entry !== undefined) &&
          currentSessionEntry?.sessionId === sessionId &&
          currentSessionEntry?.lifecycleRevision === sessionLifecycleRevision
        );
      };
      const releaseChangedSessionKill = () => {
        try {
          releaseSubagentRunKillClaim({
            runId: params.entry.runId,
            expected: params.entry,
            claim: claimedKill,
          });
        } catch (error) {
          return {
            killed: false,
            sessionId,
            error: `Subagent session changed and its kill intent could not be released: ${formatErrorMessage(error)}`,
          };
        }
        return {
          killed: false,
          sessionId,
          error: "Subagent session changed while the kill was pending; retry.",
        };
      };
      if (!ownsSessionIncarnation()) {
        return releaseChangedSessionKill();
      }
      const active = sessionId ? runtime.isEmbeddedAgentRunActive(sessionId) : false;
      if (!ownsSessionIncarnation()) {
        return releaseChangedSessionKill();
      }
      const aborted = sessionId ? runtime.abortEmbeddedAgentRun(sessionId) : false;
      if (!ownsSessionIncarnation()) {
        return releaseChangedSessionKill();
      }
      const cleared = runtime.clearSessionQueues([childSessionKey, sessionId]);
      if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
        logVerbose(
          `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
        );
      }
      if (active && !aborted) {
        try {
          releaseSubagentRunKillClaim({
            runId: params.entry.runId,
            expected: params.entry,
            claim: killClaim,
          });
        } catch (error) {
          return {
            killed: false,
            sessionId,
            error: `Subagent remained active and its kill intent could not be released: ${formatErrorMessage(error)}`,
          };
        }
        return {
          killed: false,
          sessionId,
          error: "Subagent is still active; try the kill again in a moment.",
        };
      }
      const targetState = resolveSubagentKillTargetState(params.entry);
      if (targetState) {
        const killedTarget =
          targetState.state === "terminal" &&
          targetState.task.status === "cancelled" &&
          targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
        if (killedTarget) {
          markKilledBestEffort();
        } else {
          try {
            releaseSubagentRunKillClaim({
              runId: params.entry.runId,
              expected: params.entry,
              claim: killClaim,
            });
          } catch (error) {
            return {
              killed: false,
              sessionId,
              targetState,
              error: `Completed subagent kill intent could not be released: ${formatErrorMessage(error)}`,
            };
          }
        }
        return { killed: killedTarget, sessionId, targetState };
      }
      let marked: number;
      try {
        marked = markSubagentRunTerminated({
          runId: params.entry.runId,
          reason: "killed",
          suppressTaskDelivery: params.suppressTaskDelivery,
        });
      } catch (error) {
        return {
          killed: false,
          sessionId,
          error: `Failed to persist subagent kill tombstone: ${formatErrorMessage(error)}`,
        };
      }
      await persistAbortedLastRun(true);
      return {
        killed: marked > 0,
        sessionId,
      };
    },
  });
}

async function killLatestSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
  suppressTaskDelivery?: boolean;
}): Promise<{
  entry: SubagentRunRecord;
  result: Awaited<ReturnType<typeof killSubagentRun>>;
}> {
  let entry = params.entry;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await killSubagentRun({ ...params, entry });
    if (!result.superseded) {
      return { entry, result };
    }
    const latest = getLatestLiveSubagentRunByChildSessionKey(entry.childSessionKey);
    if (!latest || latest === entry) {
      return { entry, result };
    }
    if (entry.execution.restartRecovery?.idempotencyKey !== latest.runId) {
      return { entry, result };
    }
    entry = latest;
  }
  return {
    entry,
    result: {
      killed: false,
      superseded: true,
      error: "Subagent changed generations repeatedly during kill; retry in a moment.",
    },
  };
}

async function killSubagentRunTree(params: {
  cfg: OpenClawConfig;
  runs: Iterable<SubagentRunRecord>;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys: Set<string>;
  controllerSessionKey?: string;
  suppressTaskDelivery?: boolean;
}): Promise<{ killed: number; labels: string[]; errors: string[] }> {
  let killed = 0;
  const labels: string[] = [];
  const errors: string[] = [];

  for (const run of params.runs) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || params.seenChildSessionKeys.has(childKey)) {
      continue;
    }
    const latest = getLatestLiveSubagentRunByChildSessionKey(childKey);
    if (!latest || !isSameSubagentRunGeneration(latest, run)) {
      continue;
    }
    const latestControllerSessionKey =
      latest.controllerSessionKey?.trim() || latest.requesterSessionKey?.trim();
    if (params.controllerSessionKey && latestControllerSessionKey !== params.controllerSessionKey) {
      continue;
    }
    params.seenChildSessionKeys.add(childKey);
    const entry = latest;

    if (!entry.execution.endedAt || entry.pauseReason === "sessions_yield") {
      const stopped = await killLatestSubagentRun({
        cfg: params.cfg,
        entry,
        cache: params.cache,
        suppressTaskDelivery: params.suppressTaskDelivery,
      });
      const stopResult = stopped.result;
      if (stopResult.error) {
        errors.push(`${resolveSubagentLabel(stopped.entry)}: ${stopResult.error}`);
      }
      const stoppedEntryIsCurrent = isCurrentSubagentRun(stopped.entry);
      if (stopResult.superseded || (!stopResult.killed && !stoppedEntryIsCurrent)) {
        continue;
      }
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(stopped.entry));
      }
      // A replacement generation owns its own descendant tree. The old row's
      // kill may have committed, but it must not cascade through the shared key.
      if (!stoppedEntryIsCurrent) {
        continue;
      }
    }

    const cascade = await killSubagentRunTree({
      cfg: params.cfg,
      runs: listSubagentRunsForController(childKey),
      cache: params.cache,
      seenChildSessionKeys: params.seenChildSessionKeys,
      controllerSessionKey: childKey,
      suppressTaskDelivery: params.suppressTaskDelivery,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
    errors.push(...cascade.errors);
  }

  return { killed, labels, errors };
}

async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
  suppressTaskDelivery?: boolean;
}): Promise<{ killed: number; labels: string[]; errors: string[] }> {
  return killSubagentRunTree({
    cfg: params.cfg,
    runs: listSubagentRunsForController(params.parentChildSessionKey),
    cache: params.cache,
    seenChildSessionKeys: params.seenChildSessionKeys ?? new Set<string>(),
    controllerSessionKey: params.parentChildSessionKey,
    suppressTaskDelivery: params.suppressTaskDelivery,
  });
}

/** Kills every currently controlled child run and its descendants. */
export async function killAllControlledSubagentRuns(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  runs: SubagentRunRecord[];
}) {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
      killed: 0,
      labels: [],
    };
  }
  const result = await killSubagentRunTree({
    cfg: params.cfg,
    runs: params.runs,
    cache: new Map<string, Record<string, SessionEntry>>(),
    seenChildSessionKeys: new Set<string>(),
    controllerSessionKey: params.controller.controllerSessionKey,
  });
  if (result.errors.length > 0) {
    return {
      status: "error" as const,
      error: result.errors.join("; "),
      killed: result.killed,
      labels: result.labels,
    };
  }
  return { status: "ok" as const, killed: result.killed, labels: result.labels };
}

/** Kills one controlled subagent run and any active descendants. */
export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  suppressTaskDelivery?: boolean;
}) {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestLiveSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || !isSameSubagentRunGeneration(currentEntry, params.entry)) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: currentEntry,
  });
  if (ownershipError) {
    return {
      status: "forbidden" as const,
      runId: currentEntry.runId,
      sessionKey: currentEntry.childSessionKey,
      error: ownershipError,
    };
  }
  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopped = await killLatestSubagentRun({
    cfg: params.cfg,
    entry: currentEntry,
    cache: killCache,
    suppressTaskDelivery: params.suppressTaskDelivery,
  });
  const stopResult = stopped.result;
  if (stopResult.error) {
    return {
      status: "error" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: stopResult.error,
    };
  }
  const stoppedEntryIsCurrent = isCurrentSubagentRun(stopped.entry);
  if (stopResult.superseded || (!stopResult.killed && !stoppedEntryIsCurrent)) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  if (!stoppedEntryIsCurrent) {
    return {
      status: "ok" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      killed: true as const,
      cascadeKilled: 0,
      cascadeLabels: undefined,
      text: `killed ${resolveSubagentLabel(params.entry)}.`,
    };
  }
  const seenChildSessionKeys = new Set<string>();
  const targetChildKey = params.entry.childSessionKey?.trim();
  if (targetChildKey) {
    seenChildSessionKeys.add(targetChildKey);
  }
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: params.entry.childSessionKey,
    cache: killCache,
    seenChildSessionKeys,
    suppressTaskDelivery: params.suppressTaskDelivery,
  });
  if (cascade.errors.length > 0) {
    return {
      status: "error" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: cascade.errors.join("; "),
      ...(stopResult.killed ? { killed: true as const } : {}),
      cascadeKilled: cascade.killed,
      cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    };
  }
  if (!stopResult.killed && cascade.killed === 0) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const cascadeText =
    cascade.killed > 0 ? ` (+ ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"})` : "";
  return {
    status: "ok" as const,
    runId: params.entry.runId,
    sessionKey: params.entry.childSessionKey,
    label: resolveSubagentLabel(params.entry),
    ...(stopResult.killed ? { killed: true as const } : {}),
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
    text: stopResult.killed
      ? `killed ${resolveSubagentLabel(params.entry)}${cascadeText}.`
      : `killed ${cascade.killed} descendant${cascade.killed === 1 ? "" : "s"} of ${resolveSubagentLabel(params.entry)}.`,
  };
}

/** Admin kill path for a subagent session key, bypassing caller ownership checks. */
export async function killSubagentRunAdmin(params: { cfg: OpenClawConfig; sessionKey: string }) {
  const targetSessionKey = params.sessionKey.trim();
  if (!targetSessionKey) {
    return { found: false as const, killed: false };
  }
  const entry = getLatestLiveSubagentRunByChildSessionKey(targetSessionKey);
  if (!entry) {
    return { found: false as const, killed: false };
  }

  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopped = await killLatestSubagentRun({
    cfg: params.cfg,
    entry,
    cache: killCache,
  });
  const stopResult = stopped.result;
  if (stopResult.error) {
    return {
      found: true as const,
      killed: false,
      runId: stopped.entry.runId,
      sessionKey: stopped.entry.childSessionKey,
      cascadeKilled: 0,
      error: stopResult.error,
    };
  }
  const stoppedEntryIsCurrent = isCurrentSubagentRun(stopped.entry);
  if (stopResult.superseded || (!stopResult.killed && !stoppedEntryIsCurrent)) {
    return {
      found: true as const,
      killed: false,
      runId: stopped.entry.runId,
      sessionKey: stopped.entry.childSessionKey,
      cascadeKilled: 0,
    };
  }
  if (!stoppedEntryIsCurrent) {
    return {
      found: true as const,
      killed: stopResult.killed,
      ...(stopResult.targetState ? { targetState: stopResult.targetState } : {}),
      runId: stopped.entry.runId,
      sessionKey: stopped.entry.childSessionKey,
      cascadeKilled: 0,
    };
  }
  const seenChildSessionKeys = new Set<string>([targetSessionKey]);
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: targetSessionKey,
    cache: killCache,
    seenChildSessionKeys,
  });
  // Descendant cleanup can yield long enough for the target run to finish.
  // Return the freshest registry state so task cancellation cannot make a stale kill sticky.
  const targetState = resolveSubagentKillTargetState(stopped.entry) ?? stopResult.targetState;
  const killedTarget =
    targetState?.state === "terminal" &&
    targetState.task.status === "cancelled" &&
    targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
  const stopResultAlreadyClearedAbort =
    stopResult.targetState !== undefined &&
    !(
      stopResult.targetState.state === "terminal" &&
      stopResult.targetState.task.status === "cancelled" &&
      stopResult.targetState.task.error === SUBAGENT_KILL_TASK_ERROR
    );
  if (targetState && !killedTarget && !stopResultAlreadyClearedAbort) {
    const resolved = resolveSessionEntryForKey({
      cfg: params.cfg,
      key: targetSessionKey,
      cache: killCache,
    });
    await persistSubagentAbortedLastRun({
      childSessionKey: targetSessionKey,
      storePath: resolved.storePath,
      hasSessionEntry: resolved.entry !== undefined,
      expectedSessionId: resolved.entry?.sessionId,
      expectedLifecycleRevision: resolved.entry?.lifecycleRevision,
      abortedLastRun: false,
      isCurrent: () => isCurrentSubagentRun(stopped.entry),
    });
  }

  return {
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    ...(targetState ? { targetState } : {}),
    runId: stopped.entry.runId,
    sessionKey: stopped.entry.childSessionKey,
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
  };
}

/** Restarts a controlled subagent run with a new steering message. */
export async function steerControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}): Promise<
  | {
      status: "forbidden" | "done" | "rate_limited" | "error";
      runId?: string;
      sessionKey: string;
      sessionId?: string;
      error?: string;
      text?: string;
    }
  | {
      status: "accepted";
      runId: string;
      sessionKey: string;
      sessionId?: string;
      mode: "restart";
      label: string;
      text: string;
    }
> {
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  if (params.controller.callerSessionKey === params.entry.childSessionKey) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Subagents cannot steer themselves.",
    };
  }
  const currentEntry = getLatestLiveSubagentRunByChildSessionKey(params.entry.childSessionKey);
  const currentHasPendingDescendants = currentEntry
    ? countPendingDescendantRuns(currentEntry.childSessionKey) > 0
    : false;
  if (
    !currentEntry ||
    !isSameSubagentRunGeneration(currentEntry, params.entry) ||
    isFinishedForSteerControl(currentEntry, currentHasPendingDescendants)
  ) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: currentEntry,
  });
  if (ownershipError) {
    return {
      status: "forbidden",
      runId: currentEntry.runId,
      sessionKey: currentEntry.childSessionKey,
      error: ownershipError,
    };
  }
  if (currentEntry.collect) {
    return {
      status: "forbidden",
      runId: currentEntry.runId,
      sessionKey: currentEntry.childSessionKey,
      error: "Collector subagents cannot be steered; use agents_wait or cancel the task.",
    };
  }

  const rateKey = `${params.controller.callerSessionKey}:${params.entry.childSessionKey}`;
  if (process.env.VITEST !== "true") {
    const now = Date.now();
    const lastSentAt = steerRateLimit.get(rateKey) ?? 0;
    if (now - lastSentAt < STEER_RATE_LIMIT_MS) {
      return {
        status: "rate_limited",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        error: "Steer rate limit exceeded. Wait a moment before sending another steer.",
      };
    }
    steerRateLimit.set(rateKey, now);
  }

  let ownsSteerRestart: boolean;
  try {
    ownsSteerRestart = markSubagentRunForSteerRestart(params.entry.runId, currentEntry);
  } catch (error) {
    return {
      status: "error",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: `Failed to persist steer restart ownership: ${formatErrorMessage(error)}`,
    };
  }
  if (!ownsSteerRestart) {
    return {
      status: "error",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Another subagent restart already owns this session; retry after it settles.",
    };
  }

  const targetSession = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: params.entry.childSessionKey,
    cache: new Map<string, Record<string, SessionEntry>>(),
  });
  const sessionId =
    typeof targetSession.entry?.sessionId === "string" && targetSession.entry.sessionId.trim()
      ? targetSession.entry.sessionId.trim()
      : undefined;
  const restartSessionId = sessionId ? crypto.randomUUID() : undefined;
  const runtime = await resolveSubagentControlRuntime();

  if (sessionId) {
    const active = runtime.isEmbeddedAgentRunActive(sessionId);
    const aborted = runtime.abortEmbeddedAgentRun(sessionId);
    if (active && !aborted) {
      clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
      return {
        status: "error",
        runId: params.entry.runId,
        sessionKey: params.entry.childSessionKey,
        sessionId,
        error: "Subagent reply is already finalizing and can no longer be restarted.",
      };
    }
  }
  const cleared = runtime.clearSessionQueues([params.entry.childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control steer: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }

  try {
    await subagentControlDeps.callGateway({
      method: "agent.wait",
      params: {
        runId: params.entry.runId,
        timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS,
      },
      timeoutMs: STEER_ABORT_SETTLE_TIMEOUT_MS + 2_000,
    });
  } catch {
    // Continue even if wait fails; steer should still be attempted.
  }

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  const latestAfterWait = getLatestLiveSubagentRunByChildSessionKey(currentEntry.childSessionKey);
  const hasPendingDescendantsAfterWait =
    countPendingDescendantRuns(currentEntry.childSessionKey) > 0;
  if (
    latestAfterWait !== currentEntry ||
    currentEntry.suppressAnnounceReason !== "steer-restart" ||
    currentEntry.execution.restartRecovery ||
    currentEntry.killIntent ||
    currentEntry.killReconciliation ||
    isFinishedForSteerControl(currentEntry, hasPendingDescendantsAfterWait)
  ) {
    clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  try {
    const steerLifecycleGeneration = getAgentEventLifecycleGeneration();
    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: params.entry.childSessionKey,
        sessionId: restartSessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      runId = response.runId;
    }
    let acceptedSessionEntry: SessionEntry | undefined;
    try {
      acceptedSessionEntry = loadSessionEntry({
        storePath: targetSession.storePath,
        sessionKey: params.entry.childSessionKey,
        clone: false,
        readConsistency: "latest",
      });
    } catch {
      // chat.abort remains the primary cleanup; exact session deletion is only
      // the fallback when the accepted session row can be resolved.
    }
    const terminateUnownedSteer = () =>
      terminateAcceptedCollectorRun({
        childSessionKey: params.entry.childSessionKey,
        gatewayRunId: runId,
        expectedSessionId: acceptedSessionEntry?.sessionId,
        expectedLifecycleRevision: acceptedSessionEntry?.lifecycleRevision,
        callGateway: subagentControlDeps.callGateway,
        timeoutMs: 10_000,
      });
    if (!isAgentEventLifecycleGenerationCurrent(steerLifecycleGeneration)) {
      await terminateUnownedSteer();
      clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
      return {
        status: "error",
        runId,
        sessionKey: params.entry.childSessionKey,
        sessionId: restartSessionId,
        error: "Gateway lifecycle changed before the steered run could be registered.",
      };
    }

    const replaced = replaceSubagentRunAfterSteer({
      previousRunId: params.entry.runId,
      nextRunId: runId,
      fallback: currentEntry,
      expected: currentEntry,
      allowEndedSource: true,
      runTimeoutSeconds: currentEntry.runTimeoutSeconds ?? 0,
      lifecycleGeneration: steerLifecycleGeneration,
      // Persist the steer so restart recovery cannot reissue the stale task.
      task: params.message,
    });
    if (!replaced) {
      await terminateUnownedSteer();
      clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
      return {
        status: "error",
        runId,
        sessionKey: params.entry.childSessionKey,
        sessionId: restartSessionId,
        error: "failed to replace steered subagent run",
      };
    }
  } catch (err) {
    clearSubagentRunSteerRestart(params.entry.runId, currentEntry);
    const error = formatErrorMessage(err);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId: restartSessionId,
      error,
    };
  }

  return {
    status: "accepted",
    runId,
    sessionKey: params.entry.childSessionKey,
    sessionId: restartSessionId,
    mode: "restart",
    label: resolveSubagentLabel(params.entry),
    text: `steered ${resolveSubagentLabel(params.entry)}.`,
  };
}

/** Sends a follow-up message to a controlled subagent and waits for a reply. */
export async function sendControlledSubagentMessage(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
  message: string;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return { status: "forbidden" as const, error: ownershipError };
  }
  if (params.entry.collect) {
    return {
      status: "forbidden" as const,
      error: "Collector subagents cannot receive follow-up messages; use agents_wait.",
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestLiveSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }

  const targetSessionKey = params.entry.childSessionKey;
  const parsed = parseAgentSessionKey(targetSessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
  const targetSessionEntry = loadSessionEntry({
    storePath,
    sessionKey: targetSessionKey,
    clone: false,
  });
  const targetSessionId =
    typeof targetSessionEntry?.sessionId === "string" && targetSessionEntry.sessionId.trim()
      ? targetSessionEntry.sessionId.trim()
      : undefined;

  const idempotencyKey = crypto.randomUUID();
  let runId: string = idempotencyKey;
  try {
    const baselineReply = await readLatestAssistantReplySnapshot({
      sessionKey: targetSessionKey,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      callGateway: subagentControlDeps.callGateway,
    });

    const response = await subagentControlDeps.callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.message,
        sessionKey: targetSessionKey,
        sessionId: targetSessionId,
        idempotencyKey,
        deliver: false,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: AGENT_LANE_SUBAGENT,
        timeout: 0,
      },
      timeoutMs: 10_000,
    });
    const responseRunId = typeof response?.runId === "string" ? response.runId : undefined;
    if (responseRunId) {
      runId = responseRunId;
    }

    const result = await waitForAgentRunAndReadUpdatedAssistantReply({
      runId,
      sessionKey: targetSessionKey,
      timeoutMs: 30_000,
      limit: SUBAGENT_REPLY_HISTORY_LIMIT,
      baseline: baselineReply,
      callGateway: subagentControlDeps.callGateway,
    });
    if (result.status === "timeout") {
      return { status: "timeout" as const, runId };
    }
    if (result.status === "error") {
      return {
        status: "error" as const,
        runId,
        error: result.error ?? "unknown error",
      };
    }
    return { status: "ok" as const, runId, replyText: result.replyText };
  } catch (err) {
    const error = formatErrorMessage(err);
    return { status: "error" as const, runId, error };
  }
}

const testing = {
  setDepsForTest(
    overrides?: Partial<{
      callGateway: GatewayCaller;
      patchSessionEntry: PatchSessionEntry;
      abortEmbeddedAgentRun: AbortEmbeddedAgentRun;
      isEmbeddedAgentRunActive: IsEmbeddedAgentRunActive;
      clearSessionQueues: ClearSessionQueues;
    }>,
  ) {
    subagentControlDeps = overrides
      ? {
          ...defaultSubagentControlDeps,
          ...overrides,
        }
      : defaultSubagentControlDeps;
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentControlTestApi")] =
    testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
