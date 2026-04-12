import crypto from "node:crypto";
import { clearSessionQueues } from "../auto-reply/reply/queue.js";
import {
  resolveSubagentLabel,
  resolveSubagentTargetFromRuns,
  sortSubagentRuns,
  type SubagentTargetResolution,
} from "../auto-reply/reply/subagents-utils.js";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { abortEmbeddedPiRun } from "./pi-embedded-runner/runs.js";
import {
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "./run-wait.js";
import { resolveStoredSubagentCapabilities } from "./subagent-capabilities.js";
import {
  buildLatestSubagentRunIndex,
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
  resolveSessionEntryForKey,
  type BuiltSubagentList,
  type SessionEntryResolution,
  type SubagentListItem,
} from "./subagent-list.js";
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

export const DEFAULT_RECENT_MINUTES = 30;
export const MAX_RECENT_MINUTES = 24 * 60;
export const MAX_STEER_MESSAGE_CHARS = 4_000;
export const STEER_RATE_LIMIT_MS = 2_000;
export const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;
const SUBAGENT_REPLY_HISTORY_LIMIT = 50;

const steerRateLimit = new Map<string, number>();

type GatewayCaller = typeof callGateway;

const defaultSubagentControlDeps = {
  callGateway,
};

let subagentControlDeps: {
  callGateway: GatewayCaller;
} = defaultSubagentControlDeps;

export type ResolvedSubagentController = {
  controllerSessionKey: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};
export type { BuiltSubagentList, SessionEntryResolution, SubagentListItem };
export {
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
  resolveSessionEntryForKey,
};

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

export function listControlledSubagentRuns(controllerSessionKey: string): SubagentRunRecord[] {
  const key = controllerSessionKey.trim();
  if (!key) {
    return [];
  }

  const snapshot = getSubagentRunsSnapshotForRead(subagentRuns);
  const latestByChildSessionKey = buildLatestSubagentRunIndex(snapshot).latestByChildSessionKey;
  const filtered = Array.from(latestByChildSessionKey.values()).filter((entry) => {
    const latestControllerSessionKey =
      entry.controllerSessionKey?.trim() || entry.requesterSessionKey?.trim();
    return latestControllerSessionKey === key;
  });
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

async function killSubagentRun(params: {
  cfg: OpenClawConfig;
  entry: SubagentRunRecord;
  cache: Map<string, Record<string, SessionEntry>>;
}): Promise<{ killed: boolean; sessionId?: string }> {
  if (params.entry.endedAt) {
    return { killed: false };
  }
  const childSessionKey = params.entry.childSessionKey;
  const resolved = resolveSessionEntryForKey({
    cfg: params.cfg,
    key: childSessionKey,
    cache: params.cache,
  });
  const sessionId = resolved.entry?.sessionId;
  const aborted = sessionId ? abortEmbeddedPiRun(sessionId) : false;
  const cleared = clearSessionQueues([childSessionKey, sessionId]);
  if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
    logVerbose(
      `subagents control kill: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
    );
  }
  if (resolved.entry) {
    try {
      await updateSessionStore(resolved.storePath, (store) => {
        const current = store[childSessionKey];
        if (!current) {
          return;
        }
        current.abortedLastRun = true;
        current.updatedAt = Date.now();
        store[childSessionKey] = current;
      });
    } catch (error) {
      logVerbose(
        `subagents control kill: failed to persist abortedLastRun for ${childSessionKey}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const marked = markSubagentRunTerminated({
    runId: params.entry.runId,
    childSessionKey,
    reason: "killed",
  });
  const killed = marked > 0 || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0;
  return { killed, sessionId };
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
    const existing = childRunsBySessionKey.get(childKey);
    if (!existing || run.createdAt >= existing.createdAt) {
      childRunsBySessionKey.set(childKey, run);
    }
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

    if (!run.endedAt) {
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

    if (!currentEntry.endedAt) {
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

  return {
    found: true as const,
    killed: stopResult.killed || cascade.killed > 0,
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    cascadeKilled: cascade.killed,
    cascadeLabels: cascade.killed > 0 ? cascade.labels : undefined,
  };
}

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
  if (params.controller.controlScope !== "children") {
    return {
      status: "forbidden",
      runId: params.entry.runId,
      sessionKey: params.entry.childSessionKey,
      error: "Leaf subagents cannot control other sessions.",
    };
  }
  const targetHasPendingDescendants = countPendingDescendantRuns(params.entry.childSessionKey) > 0;
  if (params.entry.endedAt && !targetHasPendingDescendants) {
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
  const currentHasPendingDescendants =
    currentEntry && countPendingDescendantRuns(currentEntry.childSessionKey) > 0;
  if (
    !currentEntry ||
    currentEntry.runId !== params.entry.runId ||
    (currentEntry.endedAt && !currentHasPendingDescendants)
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

  if (sessionId) {
    abortEmbeddedPiRun(sessionId);
  }
  const cleared = clearSessionQueues([params.entry.childSessionKey, sessionId]);
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
        sessionId,
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
      sessionId,
      error,
    };
  }

  const replaced = replaceSubagentRunAfterSteer({
    previousRunId: params.entry.runId,
    nextRunId: runId,
    fallback: params.entry,
    runTimeoutSeconds: params.entry.runTimeoutSeconds ?? 0,
  });
  if (!replaced) {
    clearSubagentRunSteerRestart(params.entry.runId);
    return {
      status: "error",
      runId,
      sessionKey: params.entry.childSessionKey,
      sessionId,
      error: "failed to replace steered subagent run",
    };
  }

  return {
    status: "accepted",
    runId,
    sessionKey: params.entry.childSessionKey,
    sessionId,
    mode: "restart",
    label: resolveSubagentLabel(params.entry),
    text: `steered ${resolveSubagentLabel(params.entry)}.`,
  };
}

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
  const store = loadSessionStore(storePath);
  const targetSessionEntry = store[targetSessionKey];
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

export function resolveControlledSubagentTarget(
  runs: SubagentRunRecord[],
  token: string | undefined,
  options?: { recentMinutes?: number; isActive?: (entry: SubagentRunRecord) => boolean },
): SubagentTargetResolution {
  return resolveSubagentTargetFromRuns({
    runs,
    token,
    recentWindowMinutes: options?.recentMinutes ?? DEFAULT_RECENT_MINUTES,
    label: (entry) => resolveSubagentLabel(entry),
    isActive: options?.isActive,
    errors: {
      missingTarget: "Missing subagent target.",
      invalidIndex: (value) => `Invalid subagent index: ${value}`,
      unknownSession: (value) => `Unknown subagent session: ${value}`,
      ambiguousLabel: (value) => `Ambiguous subagent label: ${value}`,
      ambiguousLabelPrefix: (value) => `Ambiguous subagent label prefix: ${value}`,
      ambiguousRunIdPrefix: (value) => `Ambiguous subagent run id prefix: ${value}`,
      unknownTarget: (value) => `Unknown subagent target: ${value}`,
    },
  });
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    subagentControlDeps = overrides
      ? {
          ...defaultSubagentControlDeps,
          ...overrides,
        }
      : defaultSubagentControlDeps;
  },
};
