import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "openclaw/plugin-sdk/codex-native-task-runtime";
import type {
  CodexServerNotification,
  CodexSessionSource,
  CodexSubAgentThreadSpawnSource,
  CodexThread,
  CodexThreadStartedNotification,
  CodexThreadStatus,
  CodexThreadStatusChangedNotification,
  JsonObject,
  JsonValue,
} from "./protocol.js";
import { isJsonObject } from "./protocol.js";

const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";

export type TaskLifecycleRuntime = {
  createRunningTaskRun: typeof createRunningTaskRun;
  recordTaskRunProgressByRunId: typeof recordTaskRunProgressByRunId;
  finalizeTaskRunByRunId: typeof finalizeTaskRunByRunId;
};

export type CodexNativeSubagentTaskMirrorParams = {
  parentThreadId: string;
  requesterSessionKey?: string;
  agentId?: string;
  now?: () => number;
};

const defaultRuntime: TaskLifecycleRuntime = {
  createRunningTaskRun,
  recordTaskRunProgressByRunId,
  finalizeTaskRunByRunId,
};

export class CodexNativeSubagentTaskMirror {
  private readonly mirroredThreadIds = new Set<string>();
  private readonly terminalRunIds = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly params: CodexNativeSubagentTaskMirrorParams,
    private readonly runtime: TaskLifecycleRuntime = defaultRuntime,
  ) {
    this.now = params.now ?? Date.now;
  }

  handleNotification(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return;
    }
    if (notification.method === "thread/started") {
      this.handleThreadStarted(params);
      return;
    }
    if (notification.method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      this.handleCollabAgentItem(params);
    }
  }

  private handleThreadStarted(params: JsonObject): void {
    const notification = readThreadStartedNotification(params);
    if (!notification) {
      return;
    }
    const thread = notification.thread;
    const spawn = readSubagentThreadSpawnSource(thread.source, this.params.parentThreadId);
    if (!spawn) {
      return;
    }
    const threadId = thread.id.trim();
    if (!threadId || this.mirroredThreadIds.has(threadId)) {
      return;
    }
    this.mirroredThreadIds.add(threadId);
    const runId = codexNativeSubagentRunId(threadId);
    const label =
      trimOptional(spawn.agent_nickname) ??
      trimOptional(thread.agentNickname) ??
      trimOptional(spawn.agent_role) ??
      trimOptional(thread.agentRole) ??
      "Codex subagent";
    const task =
      trimOptional(thread.preview) ??
      `Codex native subagent${label === "Codex subagent" ? "" : ` ${label}`}`;
    const createdAt = secondsToMillis(thread.createdAt) ?? this.now();
    this.runtime.createRunningTaskRun({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      sourceId: runId,
      requesterSessionKey: this.params.requesterSessionKey,
      ...(this.params.requesterSessionKey
        ? {
            ownerKey: this.params.requesterSessionKey,
            scopeKind: "session" as const,
          }
        : {}),
      agentId: this.params.agentId,
      runId,
      label,
      task,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: createdAt,
      lastEventAt: this.now(),
      progressSummary: "Codex native subagent started.",
    });
    this.applyStatus(threadId, thread.status);
  }

  private handleThreadStatusChanged(params: JsonObject): void {
    const notification = readThreadStatusChangedNotification(params);
    if (!notification) {
      return;
    }
    this.applyStatus(notification.threadId, notification.status);
  }

  private applyStatus(threadId: string, status: CodexThreadStatus | null | undefined): void {
    const statusType = status?.type;
    if (!statusType) {
      return;
    }
    const runId = codexNativeSubagentRunId(threadId);
    if (this.terminalRunIds.has(runId) && statusType !== "systemError") {
      return;
    }
    const eventAt = this.now();
    if (statusType === "active") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is active.",
      });
      return;
    }
    if (statusType === "idle") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is idle.",
        terminalSummary: "Codex native subagent finished.",
      });
      return;
    }
    if (statusType === "systemError") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        status: "failed",
        endedAt: eventAt,
        lastEventAt: eventAt,
        error: "Codex app-server reported a system error for the native subagent thread.",
        progressSummary: "Codex native subagent hit a system error.",
        terminalSummary: "Codex native subagent failed.",
      });
      return;
    }
    if (statusType === "notLoaded") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        lastEventAt: eventAt,
        progressSummary: "Codex native subagent is not loaded.",
      });
    }
  }

  private handleCollabAgentItem(params: JsonObject): void {
    const item = isJsonObject(params.item) ? params.item : undefined;
    if (!item || readString(item, "type") !== "collabAgentToolCall") {
      return;
    }
    if (readString(item, "senderThreadId") !== this.params.parentThreadId) {
      return;
    }
    const receiverThreadIds = readStringArray(item.receiverThreadIds);
    if (normalizeToolName(readString(item, "tool")) === "spawnagent") {
      for (const receiverThreadId of receiverThreadIds) {
        this.createTaskFromCollabSpawnItem(receiverThreadId, item);
      }
    }
    const agentsStates = readAgentsStates(item.agentsStates);
    for (const [threadId, state] of agentsStates) {
      this.applyCollabAgentStatus(threadId, state.status, state.message);
    }
  }

  private createTaskFromCollabSpawnItem(threadId: string, item: JsonObject): void {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId || this.mirroredThreadIds.has(normalizedThreadId)) {
      return;
    }
    this.mirroredThreadIds.add(normalizedThreadId);
    const prompt = trimOptional(readString(item, "prompt"));
    const runId = codexNativeSubagentRunId(normalizedThreadId);
    const createdAt = this.now();
    this.runtime.createRunningTaskRun({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      sourceId: runId,
      requesterSessionKey: this.params.requesterSessionKey,
      ...(this.params.requesterSessionKey
        ? {
            ownerKey: this.params.requesterSessionKey,
            scopeKind: "session" as const,
          }
        : {}),
      agentId: this.params.agentId,
      runId,
      label: "Codex subagent",
      task: prompt ?? "Codex native subagent",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: createdAt,
      lastEventAt: createdAt,
      progressSummary: "Codex native subagent spawned.",
    });
  }

  private applyCollabAgentStatus(
    threadId: string,
    status: string | undefined,
    message: string | null | undefined,
  ): void {
    const normalizedStatus = normalizeAgentStateStatus(status);
    if (!normalizedStatus) {
      return;
    }
    const runId = codexNativeSubagentRunId(threadId);
    const eventAt = this.now();
    if (normalizedStatus === "pendingInit" || normalizedStatus === "running") {
      this.runtime.recordTaskRunProgressByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        lastEventAt: eventAt,
        progressSummary:
          trimOptional(message) ??
          (normalizedStatus === "pendingInit"
            ? "Codex native subagent is initializing."
            : "Codex native subagent is running."),
      });
      return;
    }
    if (normalizedStatus === "completed") {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        status: "succeeded",
        endedAt: eventAt,
        lastEventAt: eventAt,
        progressSummary: trimOptional(message) ?? "Codex native subagent completed.",
        terminalSummary: trimOptional(message) ?? "Codex native subagent finished.",
      });
      return;
    }
    this.terminalRunIds.add(runId);
    this.runtime.finalizeTaskRunByRunId({
      runId,
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      status:
        normalizedStatus === "interrupted" || normalizedStatus === "shutdown"
          ? "cancelled"
          : "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      error: trimOptional(message) ?? `Codex native subagent status: ${normalizedStatus}`,
      progressSummary: trimOptional(message) ?? `Codex native subagent ${normalizedStatus}.`,
      terminalSummary: trimOptional(message) ?? "Codex native subagent did not complete.",
    });
  }
}

export function codexNativeSubagentRunId(threadId: string): string {
  return `codex-thread:${threadId.trim()}`;
}

export function readSubagentThreadSpawnSource(
  source: CodexSessionSource | null | undefined,
  parentThreadId: string,
): CodexSubAgentThreadSpawnSource | undefined {
  if (!source || typeof source !== "object" || !("subAgent" in source)) {
    return undefined;
  }
  const subAgent = source.subAgent;
  if (!subAgent || typeof subAgent !== "object" || !("thread_spawn" in subAgent)) {
    return undefined;
  }
  const spawn = subAgent.thread_spawn;
  if (!spawn || typeof spawn !== "object") {
    return undefined;
  }
  return spawn.parent_thread_id === parentThreadId ? spawn : undefined;
}

function readThreadStartedNotification(
  params: JsonObject,
): CodexThreadStartedNotification | undefined {
  const thread = params.thread;
  if (!isJsonObject(thread) || typeof thread.id !== "string") {
    return undefined;
  }
  return { thread: thread as CodexThread };
}

function readThreadStatusChangedNotification(
  params: JsonObject,
): CodexThreadStatusChangedNotification | undefined {
  if (typeof params.threadId !== "string") {
    return undefined;
  }
  const status = params.status;
  if (!isJsonObject(status) || !isCodexThreadStatusType(status.type)) {
    return undefined;
  }
  return {
    threadId: params.threadId,
    status: status as CodexThreadStatus,
  };
}

function isCodexThreadStatusType(value: unknown): value is CodexThreadStatus["type"] {
  return value === "notLoaded" || value === "idle" || value === "systemError" || value === "active";
}

function readAgentsStates(
  value: JsonValue | undefined,
): Map<string, { status?: string; message?: string | null }> {
  const states = new Map<string, { status?: string; message?: string | null }>();
  if (!isJsonObject(value)) {
    return states;
  }
  for (const [threadId, rawState] of Object.entries(value)) {
    if (!isJsonObject(rawState)) {
      continue;
    }
    const status = readString(rawState, "status");
    const message = readNullableString(rawState, "message");
    states.set(threadId, { status, message });
  }
  return states;
}

function readStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readString(value: JsonObject, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function readNullableString(value: JsonObject, key: string): string | null | undefined {
  const entry = value[key];
  return typeof entry === "string" || entry === null ? entry : undefined;
}

function normalizeToolName(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function normalizeAgentStateStatus(value: string | undefined): string | undefined {
  const key = value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (!key) {
    return undefined;
  }
  if (key === "pendinginit") {
    return "pendingInit";
  }
  if (key === "inprogress" || key === "running") {
    return "running";
  }
  if (key === "completed" || key === "succeeded" || key === "success") {
    return "completed";
  }
  if (key === "interrupted" || key === "cancelled" || key === "canceled" || key === "shutdown") {
    return key === "shutdown" ? "shutdown" : "interrupted";
  }
  if (key === "failed" || key === "error" || key === "systemerror") {
    return "failed";
  }
  return value?.trim();
}

function secondsToMillis(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value * 1000;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
