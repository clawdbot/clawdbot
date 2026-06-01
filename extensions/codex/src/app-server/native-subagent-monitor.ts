import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  isDurableAgentHarnessCompletionDelivery,
  type AgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntime,
  type AgentHarnessTaskRecord,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { asFiniteNumber, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  extractCodexNativeSubagentCompletions,
  type CodexNativeSubagentCompletion,
  type CodexNativeSubagentNotificationCompletion,
} from "./native-subagent-notification.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./native-subagent-task-ids.js";
import {
  codexNativeSubagentRunId,
  CodexNativeSubagentTaskMirror,
} from "./native-subagent-task-mirror.js";
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime: typeof createAgentHarnessTaskRuntime;
  deliverAgentHarnessTaskCompletion: typeof deliverAgentHarnessTaskCompletion;
};

type ParentState = {
  parentThreadId: string;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime?: AgentHarnessTaskRuntime;
  mirror?: CodexNativeSubagentTaskMirror;
  deliveredCompletionKeys: Set<string>;
};

type ChildState = {
  childThreadId: string;
  parentThreadId: string;
  transcriptPath?: string;
  transcriptPollAttempt: number;
  transcriptPollTimer?: ReturnType<typeof setTimeout>;
  transcriptTerminal: boolean;
  pendingCompletion?: CodexNativeSubagentCompletion;
  pendingCompletionEventAt?: number;
  completionDeliveryAttempt: number;
  completionDeliveryTimer?: ReturnType<typeof setTimeout>;
  deliveringCompletionKey?: string;
};

type TranscriptCompletion = CodexNativeSubagentCompletion & {
  parentThreadId?: string;
  completedAt?: number;
};

type MonitorOptions = {
  codexHome?: string;
  transcriptPollDelaysMs?: readonly number[];
  completionDeliveryRetryDelaysMs?: readonly number[];
  taskRowReconcileIntervalMs?: number;
};

const DEFAULT_TRANSCRIPT_POLL_DELAYS_MS = [
  2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const DEFAULT_TASK_ROW_RECONCILE_INTERVAL_MS = 10_000;
const RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS = 60_000;

const defaultRuntime: NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
};

const monitors = new WeakMap<CodexAppServerClient, CodexNativeSubagentMonitor>();

export function registerCodexNativeSubagentMonitor(params: {
  client: CodexAppServerClient;
  parentThreadId: string;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  codexHome?: string;
  runtime?: NativeSubagentMonitorRuntime;
}): void {
  let monitor = monitors.get(params.client);
  if (!monitor) {
    monitor = new CodexNativeSubagentMonitor(params.client, params.runtime ?? defaultRuntime, {
      codexHome: params.codexHome,
    });
    monitors.set(params.client, monitor);
  } else {
    monitor.configure({ codexHome: params.codexHome });
  }
  monitor.registerParent({
    parentThreadId: params.parentThreadId,
    requesterSessionKey: params.requesterSessionKey,
    taskRuntimeScope: params.taskRuntimeScope,
    agentId: params.agentId,
  });
}

export class CodexNativeSubagentMonitor {
  private readonly startedAt = Date.now();
  private readonly parentStates = new Map<string, ParentState>();
  private readonly childThreadParents = new Map<string, string>();
  private readonly childStates = new Map<string, ChildState>();
  private readonly childThreadIdsByAgentPath = new Map<string, string>();
  private readonly transcriptPathsByChildThreadId = new Map<string, string>();
  private codexHome?: string;
  private transcriptPollDelaysMs: readonly number[];
  private completionDeliveryRetryDelaysMs: readonly number[];
  private taskRowReconcileTimer?: ReturnType<typeof setInterval>;

  constructor(
    client: Pick<CodexAppServerClient, "addNotificationHandler" | "addCloseHandler">,
    private readonly runtime: NativeSubagentMonitorRuntime = defaultRuntime,
    options: MonitorOptions = {},
  ) {
    this.codexHome = normalizeOptionalString(options.codexHome);
    this.transcriptPollDelaysMs =
      options.transcriptPollDelaysMs ?? DEFAULT_TRANSCRIPT_POLL_DELAYS_MS;
    this.completionDeliveryRetryDelaysMs =
      options.completionDeliveryRetryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.startTaskRowReconciler(
      options.taskRowReconcileIntervalMs ?? DEFAULT_TASK_ROW_RECONCILE_INTERVAL_MS,
    );
    client.addNotificationHandler((notification) => this.handleNotification(notification));
    client.addCloseHandler?.(() => this.dispose());
  }

  dispose(): void {
    this.clearTimers();
    this.parentStates.clear();
    this.childThreadParents.clear();
    this.childStates.clear();
    this.childThreadIdsByAgentPath.clear();
    this.transcriptPathsByChildThreadId.clear();
  }

  configure(options: MonitorOptions): void {
    const codexHome = normalizeOptionalString(options.codexHome);
    if (codexHome) {
      this.codexHome = codexHome;
    }
  }

  registerParent(params: {
    parentThreadId: string;
    requesterSessionKey?: string;
    taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
    agentId?: string;
  }): void {
    const parentThreadId = params.parentThreadId.trim();
    if (!parentThreadId) {
      return;
    }
    const existing = this.parentStates.get(parentThreadId);
    if (existing) {
      existing.requesterSessionKey = params.requesterSessionKey ?? existing.requesterSessionKey;
      existing.taskRuntimeScope = params.taskRuntimeScope ?? existing.taskRuntimeScope;
      existing.agentId = params.agentId ?? existing.agentId;
      this.ensureParentTaskRuntime(existing);
    } else {
      const state: ParentState = {
        parentThreadId,
        requesterSessionKey: params.requesterSessionKey,
        taskRuntimeScope: params.taskRuntimeScope,
        agentId: params.agentId,
        deliveredCompletionKeys: new Set<string>(),
      };
      this.ensureParentTaskRuntime(state);
      this.parentStates.set(parentThreadId, {
        ...state,
      });
    }
    const state = this.parentStates.get(parentThreadId);
    if (state) {
      void this.reconcileExistingRunningTasksForParent(state);
    }
  }

  async handleNotification(notification: CodexServerNotification): Promise<void> {
    const state = this.resolveMirrorState(notification);
    if (state?.mirror) {
      try {
        state.mirror.handleNotification(notification);
      } catch (error) {
        embeddedAgentLog.warn("Failed to mirror Codex native subagent lifecycle event", {
          method: notification.method,
          error: formatErrorMessage(error),
        });
      }
    }
    await this.handleCompletionNotification(notification);
  }

  private ensureParentTaskRuntime(state: ParentState): void {
    if (state.taskRuntime || !state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    state.taskRuntime = this.runtime.createAgentHarnessTaskRuntime({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      scope: state.taskRuntimeScope,
      runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
    });
    state.mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: state.parentThreadId,
        requesterSessionKey: state.requesterSessionKey,
        agentId: state.agentId,
      },
      state.taskRuntime,
    );
  }

  private resolveMirrorState(notification: CodexServerNotification): ParentState | undefined {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return undefined;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const parentThreadId = readSpawnParentThreadId(thread);
      const childThreadId = thread ? readString(thread, "id")?.trim() : undefined;
      const agentPath = readSpawnAgentPath(thread);
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && childThreadId && parentThreadId) {
        this.registerChildThread(parentThreadId, childThreadId, { agentPath });
      }
      return state;
    }
    if (notification.method === "thread/status/changed") {
      const childThreadId = readString(params, "threadId")?.trim();
      const parentThreadId = childThreadId ? this.childThreadParents.get(childThreadId) : undefined;
      return parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const parentThreadId = item
        ? (readString(item, "senderThreadId") ?? readString(params, "threadId"))?.trim()
        : undefined;
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && parentThreadId) {
        const isSpawnAgentTool = normalizeToolName(readString(item, "tool")) === "spawnagent";
        const childThreadIds = isSpawnAgentTool
          ? new Set([
              ...readStringArray(item?.receiverThreadIds),
              ...readObjectStringKeys(item?.agentsStates),
            ])
          : new Set(readStringArray(item?.receiverThreadIds));
        for (const childThreadId of childThreadIds) {
          this.registerChildThread(parentThreadId, childThreadId);
        }
      }
      return state;
    }
    return undefined;
  }

  private async handleCompletionNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const parentThreadId = params ? readString(params, "threadId")?.trim() : undefined;
    const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    if (!state) {
      return;
    }
    const completions = extractCodexNativeSubagentCompletions(notification);
    for (const nativeCompletion of completions) {
      const childThreadId = this.resolveChildThreadIdForAgentPath(
        state.parentThreadId,
        nativeCompletion.agentPath,
      );
      const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
      if (!childState || childState.parentThreadId !== state.parentThreadId) {
        embeddedAgentLog.warn(
          "Ignoring Codex native subagent completion for unknown child thread",
          {
            parentThreadId: state.parentThreadId,
            agentPath: nativeCompletion.agentPath,
          },
        );
        continue;
      }
      const completion = toThreadCompletion(nativeCompletion, childState.childThreadId);
      await this.processCompletion(state, completion);
    }
  }

  async reconcileChildTranscript(
    childThreadId: string,
    options: { allowTreeScan?: boolean } = {},
  ): Promise<boolean> {
    const childState = this.childStates.get(childThreadId.trim());
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    if (!childState || !state || childState.transcriptTerminal) {
      return false;
    }
    const codexHome = this.codexHome;
    if (!codexHome) {
      return false;
    }
    const completion = await this.findTranscriptCompletionForChild(childState, options);
    if (!completion) {
      return false;
    }
    const transcriptParentThreadId = completion.completion.parentThreadId;
    if (transcriptParentThreadId && transcriptParentThreadId !== state.parentThreadId) {
      embeddedAgentLog.warn("Codex native subagent transcript parent did not match monitor state", {
        childThreadId: childState.childThreadId,
        expectedParentThreadId: state.parentThreadId,
        transcriptParentThreadId,
      });
      childState.transcriptPath = undefined;
      this.transcriptPathsByChildThreadId.delete(childState.childThreadId);
      return false;
    }
    await this.processCompletion(state, completion.completion, completion.completion.completedAt);
    return true;
  }

  private async processCompletion(
    state: ParentState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number = Date.now(),
  ): Promise<void> {
    this.finalizeCompletionTask(completion, eventAt);
    const childState = this.childStates.get(completion.childThreadId);
    if (childState) {
      childState.transcriptTerminal = true;
      if (childState.transcriptPollTimer) {
        clearTimeout(childState.transcriptPollTimer);
        childState.transcriptPollTimer = undefined;
      }
    }
    if (!state.requesterSessionKey) {
      return;
    }
    const completionKey = buildCompletionDedupeKey(state.parentThreadId, completion);
    if (state.deliveredCompletionKeys.has(completionKey)) {
      return;
    }
    const deliveryState =
      childState ?? this.ensureChildState(state.parentThreadId, completion.childThreadId);
    deliveryState.pendingCompletion = completion;
    deliveryState.pendingCompletionEventAt = eventAt;
    this.markCompletionDeliveryPending(completion);
    await this.deliverPendingCompletion(state, deliveryState);
  }

  private async deliverPendingCompletion(
    state: ParentState,
    childState: ChildState,
  ): Promise<void> {
    const completion = childState.pendingCompletion;
    if (!completion || !state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    const completionKey = buildCompletionDedupeKey(state.parentThreadId, completion);
    if (
      state.deliveredCompletionKeys.has(completionKey) ||
      childState.deliveringCompletionKey === completionKey
    ) {
      return;
    }
    childState.deliveringCompletionKey = completionKey;
    try {
      const delivery = await this.runtime.deliverAgentHarnessTaskCompletion({
        scope: state.taskRuntimeScope,
        childSessionKey: codexNativeSubagentRunId(completion.childThreadId),
        childSessionId: completion.childThreadId,
        announceId: `codex-native:${state.parentThreadId}:${completion.childThreadId}:${completion.status}`,
        announceType: "Codex native subagent",
        taskLabel: "Codex native subagent",
        status: completion.status,
        statusLabel: completion.statusLabel,
        result: completion.result,
        replyInstruction:
          "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup.",
      });
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        state.deliveredCompletionKeys.add(completionKey);
        childState.pendingCompletion = undefined;
        childState.pendingCompletionEventAt = undefined;
        childState.completionDeliveryAttempt = 0;
        if (childState.completionDeliveryTimer) {
          clearTimeout(childState.completionDeliveryTimer);
          childState.completionDeliveryTimer = undefined;
        }
        this.markCompletionDeliveryDelivered(completion);
        return;
      }
      const error = delivery.error ?? "completion delivery did not produce a parent response";
      this.markCompletionDeliveryPending(completion, error);
      this.scheduleCompletionDeliveryRetry(childState);
    } catch (error) {
      this.markCompletionDeliveryPending(completion, formatErrorMessage(error));
      this.scheduleCompletionDeliveryRetry(childState);
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: formatErrorMessage(error),
      });
    } finally {
      childState.deliveringCompletionKey = undefined;
    }
  }

  private markCompletionDeliveryPending(
    completion: CodexNativeSubagentCompletion,
    error?: string,
  ): void {
    const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
    if (!taskRuntime) {
      return;
    }
    taskRuntime.setDetachedTaskDeliveryStatusByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      deliveryStatus: "pending",
      ...(error ? { error } : {}),
    });
  }

  private markCompletionDeliveryDelivered(completion: CodexNativeSubagentCompletion): void {
    const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
    if (!taskRuntime) {
      return;
    }
    taskRuntime.setDetachedTaskDeliveryStatusByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      deliveryStatus: "delivered",
    });
  }

  private scheduleCompletionDeliveryRetry(childState: ChildState): void {
    if (!childState.pendingCompletion || childState.completionDeliveryTimer) {
      return;
    }
    const attempt = childState.completionDeliveryAttempt;
    const delayMs =
      this.completionDeliveryRetryDelaysMs[
        Math.min(attempt, this.completionDeliveryRetryDelaysMs.length - 1)
      ];
    childState.completionDeliveryAttempt += 1;
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      const state = this.parentStates.get(childState.parentThreadId);
      if (!state) {
        return;
      }
      void this.deliverPendingCompletion(state, childState);
    }, delayMs);
    unrefTimer(childState.completionDeliveryTimer);
  }

  private finalizeCompletionTask(completion: CodexNativeSubagentCompletion, eventAt: number): void {
    const taskRuntime = this.getTaskRuntimeForChild(completion.childThreadId);
    if (!taskRuntime) {
      return;
    }
    taskRuntime.finalizeTaskRunByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      status: completion.status,
      endedAt: eventAt,
      lastEventAt: eventAt,
      ...(completion.status === "succeeded" ? {} : { error: completion.result }),
      progressSummary: completion.result,
      terminalSummary: completion.result,
    });
  }

  private getTaskRuntimeForChild(childThreadId: string): AgentHarnessTaskRuntime | undefined {
    const childState = this.childStates.get(childThreadId.trim());
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    return state?.taskRuntime;
  }

  private registerChildThread(
    parentThreadId: string,
    childThreadId: string,
    options: { agentPath?: string; scheduleTranscriptPoll?: boolean } = {},
  ): void {
    const normalizedParentThreadId = parentThreadId.trim();
    const normalizedChildThreadId = childThreadId.trim();
    if (!normalizedParentThreadId || !normalizedChildThreadId) {
      return;
    }
    this.childThreadParents.set(normalizedChildThreadId, normalizedParentThreadId);
    this.childThreadIdsByAgentPath.set(
      buildParentAgentPathKey(normalizedParentThreadId, normalizedChildThreadId),
      normalizedChildThreadId,
    );
    const agentPath = normalizeOptionalString(options.agentPath);
    if (agentPath) {
      this.childThreadIdsByAgentPath.set(
        buildParentAgentPathKey(normalizedParentThreadId, agentPath),
        normalizedChildThreadId,
      );
    }
    let childState = this.childStates.get(normalizedChildThreadId);
    if (!childState) {
      childState = {
        childThreadId: normalizedChildThreadId,
        parentThreadId: normalizedParentThreadId,
        transcriptPollAttempt: 0,
        transcriptTerminal: false,
        completionDeliveryAttempt: 0,
      };
      this.childStates.set(normalizedChildThreadId, childState);
    }
    if (options.scheduleTranscriptPoll !== false) {
      this.scheduleTranscriptPoll(childState);
    }
  }

  private ensureChildState(parentThreadId: string, childThreadId: string): ChildState {
    this.registerChildThread(parentThreadId, childThreadId);
    return this.childStates.get(childThreadId.trim())!;
  }

  private resolveChildThreadIdForAgentPath(
    parentThreadId: string,
    agentPath: string,
  ): string | undefined {
    const mapped = this.childThreadIdsByAgentPath.get(
      buildParentAgentPathKey(parentThreadId, agentPath),
    );
    if (mapped) {
      return mapped;
    }
    const exactChild = this.childStates.get(agentPath);
    return exactChild?.parentThreadId === parentThreadId ? exactChild.childThreadId : undefined;
  }

  private scheduleTranscriptPoll(childState: ChildState): void {
    if (!this.codexHome || childState.transcriptTerminal || childState.transcriptPollTimer) {
      return;
    }
    const attempt = childState.transcriptPollAttempt;
    const delayMs =
      this.transcriptPollDelaysMs[Math.min(attempt, this.transcriptPollDelaysMs.length - 1)];
    childState.transcriptPollAttempt += 1;
    childState.transcriptPollTimer = setTimeout(() => {
      childState.transcriptPollTimer = undefined;
      void this.reconcileChildTranscript(childState.childThreadId)
        .catch((error: unknown) => {
          embeddedAgentLog.warn("Failed to reconcile Codex native subagent transcript", {
            childThreadId: childState.childThreadId,
            error: formatErrorMessage(error),
          });
          return false;
        })
        .then((reconciled) => {
          if (!reconciled) {
            this.scheduleTranscriptPoll(childState);
          }
        });
    }, delayMs);
    unrefTimer(childState.transcriptPollTimer);
  }

  private clearTimers(): void {
    if (this.taskRowReconcileTimer) {
      clearInterval(this.taskRowReconcileTimer);
      this.taskRowReconcileTimer = undefined;
    }
    for (const childState of this.childStates.values()) {
      if (childState.transcriptPollTimer) {
        clearTimeout(childState.transcriptPollTimer);
        childState.transcriptPollTimer = undefined;
      }
      if (childState.completionDeliveryTimer) {
        clearTimeout(childState.completionDeliveryTimer);
        childState.completionDeliveryTimer = undefined;
      }
    }
  }

  private startTaskRowReconciler(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    this.taskRowReconcileTimer = setInterval(
      () => {
        void this.reconcileKnownTaskRows().catch((error: unknown) => {
          embeddedAgentLog.warn("Failed to reconcile Codex native subagent task rows", {
            error: formatErrorMessage(error),
          });
        });
      },
      Math.max(1, Math.floor(intervalMs)),
    );
    unrefTimer(this.taskRowReconcileTimer);
  }

  async reconcileKnownTaskRows(): Promise<void> {
    if (!this.codexHome) {
      return;
    }
    for (const state of this.parentStates.values()) {
      await this.reconcileKnownTaskRowsForParent(state);
    }
  }

  private async reconcileExistingRunningTasksForParent(state: ParentState): Promise<void> {
    if (!this.codexHome || !state.taskRuntime) {
      return;
    }
    const tasks = state.taskRuntime.listTaskRecords();
    const candidates: Array<{ childThreadId: string; childState: ChildState }> = [];
    for (const task of tasks) {
      if (!this.shouldReconcileCodexNativeTask(task)) {
        continue;
      }
      if (state.requesterSessionKey && task.requesterSessionKey !== state.requesterSessionKey) {
        continue;
      }
      const childThreadId = task.runId!.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length).trim();
      if (!childThreadId) {
        continue;
      }
      this.registerChildThread(state.parentThreadId, childThreadId, {
        scheduleTranscriptPoll: false,
      });
      const childState = this.childStates.get(childThreadId);
      if (childState && !childState.transcriptPollTimer) {
        candidates.push({ childThreadId, childState });
      }
    }
    await this.primeTranscriptPathCacheForChildren(candidates.map(({ childState }) => childState));
    for (const { childThreadId, childState } of candidates) {
      const reconciled = await this.reconcileChildTranscript(childThreadId, {
        allowTreeScan: false,
      });
      if (!reconciled) {
        this.scheduleTranscriptPoll(childState);
      }
    }
  }

  private async reconcileKnownTaskRowsForParent(state: ParentState): Promise<void> {
    if (!this.codexHome || !state.taskRuntime) {
      return;
    }
    const tasks = state.taskRuntime.listTaskRecords();
    const candidates: Array<{
      task: AgentHarnessTaskRecord;
      childThreadId: string;
      childState: ChildState;
    }> = [];
    for (const task of tasks) {
      if (!this.shouldReconcileCodexNativeTask(task)) {
        continue;
      }
      const childThreadId = task.runId!.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length).trim();
      if (!childThreadId) {
        continue;
      }
      this.registerChildThread(state.parentThreadId, childThreadId, {
        scheduleTranscriptPoll: false,
      });
      const childState = this.childStates.get(childThreadId);
      if (!childState || childState.transcriptPollTimer) {
        continue;
      }
      candidates.push({ task, childThreadId, childState });
    }
    await this.primeTranscriptPathCacheForChildren(candidates.map(({ childState }) => childState));
    for (const { task, childThreadId, childState } of candidates) {
      const transcriptCompletion = await this.findTranscriptCompletionForChild(childState, {
        allowTreeScan: false,
      });
      if (!transcriptCompletion) {
        this.scheduleTranscriptPoll(childState);
        continue;
      }
      const parentThreadId =
        transcriptCompletion.completion.parentThreadId ??
        this.childThreadParents.get(childThreadId);
      if (!parentThreadId) {
        embeddedAgentLog.warn("Codex native subagent transcript did not include a parent thread", {
          childThreadId,
          transcriptPath: transcriptCompletion.transcriptPath,
        });
        continue;
      }
      if (parentThreadId !== state.parentThreadId) {
        continue;
      }
      state.agentId = state.agentId ?? task.agentId;
      await this.processCompletion(
        state,
        transcriptCompletion.completion,
        transcriptCompletion.completion.completedAt,
      );
    }
  }

  private shouldReconcileCodexNativeTask(task: AgentHarnessTaskRecord): boolean {
    if (
      task.runtime !== "subagent" ||
      task.taskKind !== "codex-native" ||
      !task.runId?.startsWith(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX)
    ) {
      return false;
    }
    if (
      task.status === "running" ||
      task.status === "queued" ||
      task.deliveryStatus === "pending"
    ) {
      return true;
    }
    return task.deliveryStatus === "not_applicable" && this.isRecentTerminalTask(task);
  }

  private isRecentTerminalTask(task: AgentHarnessTaskRecord): boolean {
    if (
      task.status !== "succeeded" &&
      task.status !== "failed" &&
      task.status !== "timed_out" &&
      task.status !== "cancelled" &&
      task.status !== "lost"
    ) {
      return false;
    }
    const earliestRelevantAt = this.startedAt - RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS;
    return [task.createdAt, task.startedAt, task.endedAt, task.lastEventAt].some(
      (timestamp) => typeof timestamp === "number" && timestamp >= earliestRelevantAt,
    );
  }

  private async primeTranscriptPathCacheForChildren(
    childStates: readonly ChildState[],
  ): Promise<void> {
    const codexHome = this.codexHome;
    if (!codexHome) {
      return;
    }
    const missingChildThreadIds = new Set(
      childStates
        .filter(
          (childState) =>
            !childState.transcriptPath &&
            !this.transcriptPathsByChildThreadId.has(childState.childThreadId),
        )
        .map((childState) => childState.childThreadId),
    );
    if (missingChildThreadIds.size === 0) {
      return;
    }
    const transcriptPaths = await findTranscriptPaths({
      codexHome,
      childThreadIds: missingChildThreadIds,
    });
    for (const [childThreadId, transcriptPath] of transcriptPaths) {
      this.transcriptPathsByChildThreadId.set(childThreadId, transcriptPath);
      const childState = this.childStates.get(childThreadId);
      if (childState) {
        childState.transcriptPath = transcriptPath;
      }
    }
  }

  private async findTranscriptCompletionForChild(
    childState: ChildState,
    options: { allowTreeScan?: boolean } = {},
  ): Promise<{ transcriptPath: string; completion: TranscriptCompletion } | undefined> {
    const codexHome = this.codexHome;
    if (!codexHome) {
      return undefined;
    }
    const transcriptPath =
      childState.transcriptPath ??
      this.transcriptPathsByChildThreadId.get(childState.childThreadId);
    const completion = await findTranscriptCompletion({
      codexHome,
      childThreadId: childState.childThreadId,
      transcriptPath,
      allowTreeScan: options.allowTreeScan ?? true,
    });
    if (completion) {
      childState.transcriptPath = completion.transcriptPath;
      this.transcriptPathsByChildThreadId.set(childState.childThreadId, completion.transcriptPath);
    }
    return completion;
  }
}

function buildCompletionDedupeKey(
  parentThreadId: string,
  completion: CodexNativeSubagentCompletion,
): string {
  const hash = createHash("sha256").update(completion.result).digest("hex").slice(0, 16);
  return `${parentThreadId}:${completion.childThreadId}:${completion.status}:${hash}`;
}

function buildParentAgentPathKey(parentThreadId: string, agentPath: string): string {
  return `${parentThreadId}\0${agentPath}`;
}

function toThreadCompletion(
  completion: CodexNativeSubagentNotificationCompletion,
  childThreadId: string,
): CodexNativeSubagentCompletion {
  return {
    childThreadId,
    status: completion.status,
    statusLabel: completion.statusLabel,
    result: completion.result,
  };
}

function readSpawnParentThreadId(thread: JsonObject | undefined): string | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  const spawn = isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
  return readString(spawn, "parent_thread_id")?.trim();
}

function readSpawnAgentPath(thread: JsonObject | undefined): string | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  const spawn = isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
  return readString(spawn, "agent_path")?.trim();
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readObjectStringKeys(value: JsonValue | undefined): string[] {
  if (!isJsonObject(value)) {
    return [];
  }
  return Object.keys(value).filter((entry) => entry.trim() !== "");
}

function normalizeToolName(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

async function findTranscriptCompletion(params: {
  codexHome: string;
  childThreadId: string;
  transcriptPath?: string;
  allowTreeScan?: boolean;
}): Promise<
  | {
      transcriptPath: string;
      completion: TranscriptCompletion;
    }
  | undefined
> {
  const transcriptPath =
    params.transcriptPath ??
    (params.allowTreeScan === false
      ? undefined
      : await findTranscriptPath({
          codexHome: params.codexHome,
          childThreadId: params.childThreadId,
        }));
  if (!transcriptPath) {
    return undefined;
  }
  const completion = await readTranscriptCompletion(transcriptPath, params.childThreadId);
  return completion ? { transcriptPath, completion } : undefined;
}

async function findTranscriptPaths(params: {
  codexHome: string;
  childThreadIds: ReadonlySet<string>;
}): Promise<Map<string, string>> {
  const sessionsDir = path.join(params.codexHome, "sessions");
  const found = new Map<string, string>();
  const stack = [sessionsDir];
  while (stack.length > 0 && found.size < params.childThreadIds.size) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      for (const childThreadId of params.childThreadIds) {
        if (!found.has(childThreadId) && entry.name.includes(childThreadId)) {
          found.set(childThreadId, entryPath);
        }
      }
    }
  }
  return found;
}

async function findTranscriptPath(params: {
  codexHome: string;
  childThreadId: string;
}): Promise<string | undefined> {
  const sessionsDir = path.join(params.codexHome, "sessions");
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name.includes(params.childThreadId)
      ) {
        return entryPath;
      }
    }
  }
  return undefined;
}

async function readTranscriptCompletion(
  transcriptPath: string,
  childThreadId: string,
): Promise<TranscriptCompletion | undefined> {
  let contents: string;
  try {
    contents = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return undefined;
  }
  let parentThreadId: string | undefined;
  let completion: TranscriptCompletion | undefined;
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: JsonValue;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isJsonObject(entry)) {
      continue;
    }
    const payload = isJsonObject(entry.payload) ? entry.payload : undefined;
    if (!payload) {
      continue;
    }
    if (readString(entry, "type") === "session_meta") {
      parentThreadId = readTranscriptParentThreadId(payload) ?? parentThreadId;
      continue;
    }
    if (readString(entry, "type") !== "event_msg") {
      continue;
    }
    const payloadType = readString(payload, "type");
    if (payloadType === "task_complete") {
      completion = {
        childThreadId,
        parentThreadId,
        status: "succeeded",
        statusLabel: "task_complete",
        result:
          readString(payload, "last_agent_message")?.trim() ||
          readString(payload, "message")?.trim() ||
          "(no output)",
        completedAt: secondsToMillis(readNumber(payload, "completed_at")) ?? readTimestamp(entry),
      };
    } else if (payloadType === "task_failed") {
      const result =
        readString(payload, "last_agent_message")?.trim() ||
        readString(payload, "error")?.trim() ||
        readString(payload, "message")?.trim() ||
        "Codex native subagent failed.";
      completion = {
        childThreadId,
        parentThreadId,
        status: "failed",
        statusLabel: "task_failed",
        result,
        completedAt: readTimestamp(entry),
      };
    }
  }
  return completion;
}

function readTranscriptParentThreadId(payload: JsonObject): string | undefined {
  const source = isJsonObject(payload.source) ? payload.source : undefined;
  const subagent =
    (isJsonObject(source?.subagent) ? source.subagent : undefined) ??
    (isJsonObject(source?.subAgent) ? source.subAgent : undefined);
  const spawn = isJsonObject(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
  return readString(spawn, "parent_thread_id")?.trim();
}

function readNumber(record: JsonObject, key: string): number | undefined {
  return asFiniteNumber(record[key]);
}

function secondsToMillis(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 1000);
}

function readTimestamp(entry: JsonObject): number | undefined {
  const timestamp = readString(entry, "timestamp");
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}
