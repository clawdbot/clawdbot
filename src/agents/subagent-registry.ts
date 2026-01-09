import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterProvider?: string;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  archiveAtMs?: number;
  announceHandled: boolean;
};

const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;

function resolveArchiveAfterMs() {
  const cfg = loadConfig();
  const minutes = cfg.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

async function sweepSubagentRuns() {
  const now = Date.now();
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!entry.archiveAtMs || entry.archiveAtMs > now) continue;
    subagentRuns.delete(runId);
    try {
      await callGateway({
        method: "sessions.delete",
        params: { key: entry.childSessionKey, deleteTranscript: true },
        timeoutMs: 10_000,
      });
    } catch {
      // ignore
    }
  }
  if (subagentRuns.size === 0) stopSweeper();
}

function ensureListener() {
  if (listenerStarted) return;
  listenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") return;
    const entry = subagentRuns.get(evt.runId);
    if (!entry) return;
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt =
        typeof evt.data?.startedAt === "number"
          ? (evt.data.startedAt as number)
          : undefined;
      if (startedAt) entry.startedAt = startedAt;
      return;
    }
    if (phase !== "end" && phase !== "error") return;
    const endedAt =
      typeof evt.data?.endedAt === "number"
        ? (evt.data.endedAt as number)
        : Date.now();
    entry.endedAt = endedAt;

    if (!beginSubagentAnnounce(evt.runId)) {
      if (entry.cleanup === "delete") {
        subagentRuns.delete(evt.runId);
      }
      return;
    }
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterProvider: entry.requesterProvider,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
    });
    if (entry.cleanup === "delete") {
      subagentRuns.delete(evt.runId);
    }
  });
}

export function beginSubagentAnnounce(runId: string) {
  const entry = subagentRuns.get(runId);
  if (!entry) return false;
  if (entry.announceHandled) return false;
  entry.announceHandled = true;
  return true;
}

export function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterProvider?: string;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
}) {
  const now = Date.now();
  const archiveAfterMs = resolveArchiveAfterMs();
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterProvider: params.requesterProvider,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    label: params.label,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    announceHandled: false,
  });
  ensureListener();
  if (archiveAfterMs) startSweeper();
  void probeImmediateCompletion(params.runId);
}

async function probeImmediateCompletion(runId: string) {
  try {
    const wait = (await callGateway({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs: 0,
      },
      timeoutMs: 2000,
    })) as { status?: string; startedAt?: number; endedAt?: number };
    if (wait?.status !== "ok" && wait?.status !== "error") return;
    const entry = subagentRuns.get(runId);
    if (!entry) return;
    if (typeof wait.startedAt === "number") entry.startedAt = wait.startedAt;
    if (typeof wait.endedAt === "number") entry.endedAt = wait.endedAt;
    if (!entry.endedAt) entry.endedAt = Date.now();
    if (!beginSubagentAnnounce(runId)) return;
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterProvider: entry.requesterProvider,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
    });
    if (entry.cleanup === "delete") {
      subagentRuns.delete(runId);
    }
  } catch {
    // ignore
  }
}

export function resetSubagentRegistryForTests() {
  subagentRuns.clear();
  stopSweeper();
}

export function releaseSubagentRun(runId: string) {
  subagentRuns.delete(runId);
  if (subagentRuns.size === 0) stopSweeper();
}
