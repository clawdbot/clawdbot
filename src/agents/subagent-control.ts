/**
 * Implements subagent control operations: list, kill, steer, and send-message.
 * The module enforces controller ownership before mutating child sessions or
 * routing internal follow-up messages.
 */
import crypto from "node:crypto";
import type { ClearSessionQueueResult } from "../auto-reply/reply/queue.js";
import { resolveSubagentLabel, sortSubagentRuns } from "../auto-reply/reply/subagents-utils.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
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
import { buildLatestSubagentRunIndex, resolveSessionEntryForKey } from "./subagent-list.js";
import {
  resolveFinalizedSubagentTaskState,
  resolveKilledSubagentTaskEndedAt,
} from "./subagent-registry-completion.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
} from "./subagent-registry-read.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import {
  clearSubagentRunSteerRestart,
  countPendingDescendantRuns,
  markSubagentRunTerminated,
  markSubagentRunForSteerRestart,
  replaceSubagentRunAfterSteer,
} from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
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

/** Lists latest child runs controlled by a session key. */
export function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }

  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const latestByChildSessionKey = buildLatestSubagentRunIndex(snapshot).latestByChildSessionKey;
  const filtered = Array.from(latestByChildSessionKey.values()).filter((entry) =>
    isSubagentRunVisibleToSession(entry, key),
  );
  return sortSubagentRuns(filtered);
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
  return Boolean(entry.endedAt) && entry.pauseReason !== "sessions_yield" && !hasPendingDescendants;
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
  return typeof entry.endedAt === "number" &&
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
  abortedLastRun: boolean;
}): Promise<void> {
  if (!params.hasSessionEntry) {
    return;
  }
  try {
    await subagentControlDeps.patchSessionEntry(
      { storePath: params.storePath, sessionKey: params.childSessionKey },
      (current) => ({
        ...current,
        abortedLastRun: params.abortedLastRun,
        updatedAt: Date.now(),
      }),
      { replaceEntry: true },
    );
  } catch (error) {
    logVerbose(
      `subagents control kill: failed to persist abortedLastRun=${params.abortedLastRun} for ${params.childSessionKey}: ${formatErrorMessage(error)}`,
    );
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
}): Promise<{
  killed: boolean;
  sessionId?: string;
  targetState?: SubagentKillTargetState;
}> {
  const initialTargetState = resolveSubagentKillTargetState(params.entry);
  if (initialTargetState) {
    if (
      params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      params.entry.suppressAnnounceReason !== "steer-restart"
    ) {
      markSubagentRunTerminatedBestEffort({
        runId: params.entry.runId,
        childSessionKey: params.entry.childSessionKey,
        reason: "killed",
      });
    }
    return { killed: false, targetState: initialTargetState };
  }
  if (params.entry.endedAt && params.entry.pauseReason !== "sessions_yield") {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const runtime = await resolveSubagentControlRuntime();
  const targetStateAfterRuntimeLoad = resolveSubagentKillTargetState(params.entry);
  if (targetStateAfterRuntimeLoad) {
    if (
      params.entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
      params.entry.suppressAnnounceReason !== "steer-restart"
    ) {
      markSubagentRunTerminatedBestEffort({
        runId: params.entry.runId,
        childSessionKey,
        reason: "killed",
      });
    }
    return { killed: false, sessionId, targetState: targetStateAfterRuntimeLoad };
  }
  const active = sessionId ? runtime.isEmbeddedAgentRunActive(sessionId) : false;
  const aborted = sessionId ? runtime.abortEmbeddedAgentRun(sessionId) : false;
  const cleared = runtime.clearSessionQueues([childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  if (active && !aborted) {
    return { killed: false, sessionId };
  }
  const persistAbortedLastRun = (abortedLastRun: boolean) =>
    persistSubagentAbortedLastRun({
      childSessionKey,
      storePath: resolved.storePath,
      hasSessionEntry: resolved.entry !== undefined,
      abortedLastRun,
    });
  await persistAbortedLastRun(true);
  const targetState = resolveSubagentKillTargetState(params.entry);
  if (targetState) {
    const killedTarget =
      targetState.state === "terminal" &&
      targetState.task.status === "cancelled" &&
      targetState.task.error === SUBAGENT_KILL_TASK_ERROR;
    if (killedTarget) {
      markSubagentRunTerminatedBestEffort({
        runId: params.entry.runId,
        childSessionKey,
        reason: "killed",
      });
    } else {
      await persistAbortedLastRun(false);
    }
    const killed =
      killedTarget && (aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0);
    return { killed, sessionId, targetState };
  }
  const marked = markSubagentRunTerminatedBestEffort({
    runId: params.entry.runId,
    childSessionKey,
    reason: "killed",
  });
  const killed = marked > 0 || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0;
  return {
    killed,
    sessionId,
  };
}

async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
}): Promise<{ killed: number; labels: string[] }> {
  const childRunsBySessionKey = new Map<string, SubagentRunRecord>();
  for (const run of listSubagentRunsForController(params.parentChildSessionKey)) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey) {
      continue;
    }
    const latest = getLatestSubagentRunByChildSessionKey(childKey);
    const latestControllerSessionKey =
      latest?.controllerSessionKey?.trim() || latest?.requesterSessionKey?.trim();
    if (
      !latest ||
      latest.runId !== run.runId ||
      latestControllerSessionKey !== params.parentChildSessionKey
    ) {
      continue;
    }
    childRunsBySessionKey.set(childKey, run);
  }
  const childRuns = Array.from(childRunsBySessionKey.values());
  const seenChildSessionKeys = params.seenChildSessionKeys ?? new Set<string>();
  let killed = 0;
  const labels: string[] = [];

  for (const run of childRuns) {
    const childKey = run.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!run.endedAt || run.pauseReason === "sessions_yield") {
      const stopResult = await killSubagentRun({
        cfg: params.cfg,
        entry: run,
        cache: params.cache,
      });
      if (stopResult.killed) {
        killed += 1;
        labels.push(resolveSubagentLabel(run));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache: params.cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
  }

  return { killed, labels };
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
  const cache = new Map<string, Record<string, SessionEntry>>();
  const seenChildSessionKeys = new Set<string>();
  const killedLabels: string[] = [];
  let killed = 0;
  for (const entry of params.runs) {
    const childKey = entry.childSessionKey?.trim();
    if (!childKey || seenChildSessionKeys.has(childKey)) {
      continue;
    }
    const currentEntry = getLatestSubagentRunByChildSessionKey(childKey);
    if (!currentEntry || currentEntry.runId !== entry.runId) {
      continue;
    }
    seenChildSessionKeys.add(childKey);

    if (!currentEntry.endedAt || currentEntry.pauseReason === "sessions_yield") {
      const stopResult = await killSubagentRun({ cfg: params.cfg, entry: currentEntry, cache });
      if (stopResult.killed) {
        killed += 1;
        killedLabels.push(resolveSubagentLabel(currentEntry));
      }
    }

    const cascade = await cascadeKillChildren({
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    killedLabels.push(...cascade.labels);
  }
  return { status: "ok" as const, killed, labels: killedLabels };
}

/** Kills one controlled subagent run and any active descendants. */
export async function killControlledSubagentRun(params: {
  cfg: OpenClawConfig;
  controller: ResolvedSubagentController;
  entry: SubagentRunRecord;
}) {
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  if (!currentEntry || currentEntry.runId !== params.entry.runId) {
    return {
      status: "done" as const,
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      label: resolveSubagentLabel(params.entry),
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
    };
  }
  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry: currentEntry,
    cache: killCache,
  });
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
  });
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
  const entry = getLatestSubagentRunByChildSessionKey(targetSessionKey);
  if (!entry) {
    return { found: false as const, killed: false };
  }

  const killCache = new Map<string, Record<string, SessionEntry>>();
  const stopResult = await killSubagentRun({
    cfg: params.cfg,
    entry,
    cache: killCache,
  });
  const seenChildSessionKeys = new Set<string>([targetSessionKey]);
  const cascade = await cascadeKillChildren({
    cfg: params.cfg,
    parentChildSessionKey: targetSessionKey,
    cache: killCache,
    seenChildSessionKeys,
  });
  // Descendant cleanup can yield long enough for the target run to finish.
  // Return the freshest registry state so task cancellation cannot make a stale kill sticky.
  const targetState = resolveSubagentKillTargetState(entry) ?? stopResult.targetState;
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
      abortedLastRun: false,
    });
  }

  return {
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    ...(targetState ? { targetState } : {}),
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
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
  const ownershipError = ensureControllerOwnsRun({
    controller: params.controller,
    entry: params.entry,
  });
  if (ownershipError) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: ownershipError,
    };
  }
  if (params.entry.collect) {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Collector subagents cannot be steered; use agents_wait or cancel the task.",
    };
  }
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const targetHasPendingDescendants = countPendingDescendantRuns(params.entry.childSessionKey) > 0;
  if (isFinishedForSteerControl(params.entry, targetHasPendingDescendants)) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
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
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
  const currentHasPendingDescendants = currentEntry
    ? countPendingDescendantRuns(currentEntry.childSessionKey) > 0
    : false;
  if (
    !currentEntry ||
    currentEntry.runId !== params.entry.runId ||
    isFinishedForSteerControl(currentEntry, currentHasPendingDescendants)
  ) {
    return {
      status: "done",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      text: `${resolveSubagentLabel(params.entry)} is already finished.`,
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

  markSubagentRunForSteerRestart(params.entry.runId);

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
      clearSubagentRunSteerRestart(params.entry.runId);
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
  try {
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
  } catch (err) {
    clearSubagentRunSteerRestart(params.entry.runId);
    const error = formatErrorMessage(err);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId: restartSessionId,
      error,
    };
  }

  const replaced = replaceSubagentRunAfterSteer({
    previousRunId: params.entry.runId,
    nextRunId: runId,
    fallback: params.entry,
    runTimeoutSeconds: params.entry.runTimeoutSeconds ?? 0,
    // Preserve the steered instruction so that restart redispatch rewraps the
    // new message rather than the stale pre-steer task. Persisting the older
    // task would cause `recoverOrphanedSubagentSessions` to re-issue the
    // original instruction after a crash, silently dropping the user's steer.
    task: params.message,
  });
  if (!replaced) {
    clearSubagentRunSteerRestart(params.entry.runId);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId: restartSessionId,
      error: "failed to replace steered subagent run",
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
  const currentEntry = getLatestSubagentRunByChildSessionKey(params.entry.childSessionKey);
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
