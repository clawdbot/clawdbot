/**
 * Mirrors Codex native subagent lifecycle and completion into OpenClaw task
 * runtime records, with app-server history as the recovery source.
 */
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  isDurableAgentHarnessCompletionDelivery,
  type AgentHarnessTaskRecord,
  type AgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { asFiniteNumber, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  codexNativeSubagentNotifications as nativeSubagentNotifications,
  type CodexNativeSubagentCompletion,
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

type NativeSubagentMonitorClient = Pick<
  CodexAppServerClient,
  "request" | "addNotificationHandler" | "addCloseHandler"
>;

type ParentState = {
  parentThreadId: string;
  // Overlapping runs share this parent; the last owner releases it only after
  // detached children finish recovery and delivery.
  ownerCount: number;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime?: AgentHarnessTaskRuntime;
  mirror?: CodexNativeSubagentTaskMirror;
};

type ChildState = {
  childThreadId: string;
  parentThreadId: string;
  agentPathKeys: Set<string>;
  assistantMessagesByTurn: Map<string, ChildAssistantMessages>;
  recoveryAttempt: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  recoveryInFlight?: Promise<boolean>;
  terminal: boolean;
  fallbackCompletion?: RecoveredCompletion;
  pendingCompletion?: CodexNativeSubagentCompletion;
  completionDeliveryAttempt: number;
  completionDeliveryTimer?: ReturnType<typeof setTimeout>;
  deliveringCompletion: boolean;
  deliveryOwnerKey?: string;
  settledWithoutCompletion: boolean;
};

type ChildAssistantMessages = {
  texts: Map<string, string>;
  order: string[];
  commentaryIds: Set<string>;
  finalMessageIds: Set<string>;
};

type RecoveredCompletion = CodexNativeSubagentCompletion & {
  completedAt?: number;
};

type ThreadRecovery = {
  parentThreadId?: string;
  completion?: RecoveredCompletion;
  fallbackCompletion?: RecoveredCompletion;
  resumable: boolean;
  threadState: "unavailable" | "active" | "system_error" | "other";
};

type ThreadStatusRevision = {
  value: number;
  readers: number;
};

type TaskRecoveryCandidate = {
  childThreadId: string;
  recoveryAttempt: number;
  requesterSessionKey: string;
  taskRuntimeScope: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime: AgentHarnessTaskRuntime;
};

type MonitorOptions = {
  recoveryPollDelaysMs?: readonly number[];
  completionDeliveryRetryDelaysMs?: readonly number[];
  completionDeliveryMaxRetries?: number;
  now?: () => number;
  retainClient?: () => (() => void) | undefined;
};

const DEFAULT_RECOVERY_POLL_DELAYS_MS = [
  2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS = 60_000;
const THREAD_READ_TIMEOUT_MS = 30_000;
const NATIVE_SUBAGENT_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "item/agentMessage/delta",
  "item/started",
  "item/completed",
  // App-server exposes no typed terminal subagent result. Keep this one raw
  // boundary until its protocol provides the child's terminal status and text.
  "rawResponseItem/completed",
]);
const RECOVERY_REVISION_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/completed",
]);

const defaultRuntime: NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
};

const monitors = new WeakMap<CodexAppServerClient, Monitor>();
const completionDeliveryOwners = new Map<string, ChildState>();

function registerMonitor(params: {
  client: CodexAppServerClient;
  parentThreadId: string;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  runtime?: NativeSubagentMonitorRuntime;
  retainClient?: () => (() => void) | undefined;
}): { unregister: () => void } {
  let monitor = monitors.get(params.client);
  if (!monitor) {
    monitor = new Monitor(params.client, params.runtime ?? defaultRuntime, {
      retainClient: params.retainClient,
    });
    monitors.set(params.client, monitor);
  }
  return monitor.registerParent({
    parentThreadId: params.parentThreadId,
    requesterSessionKey: params.requesterSessionKey,
    taskRuntimeScope: params.taskRuntimeScope,
    agentId: params.agentId,
  });
}

class Monitor {
  private readonly parentStates = new Map<string, ParentState>();
  private readonly childStates = new Map<string, ChildState>();
  private readonly childThreadIdsByAgentPath = new Map<string, string>();
  private readonly taskReconciliations = new Map<string, Promise<void>>();
  private readonly taskReconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly threadStatusRevisions = new Map<string, ThreadStatusRevision>();
  private readonly recoveryPollDelaysMs: readonly number[];
  private readonly completionDeliveryRetryDelaysMs: readonly number[];
  private readonly completionDeliveryMaxRetries: number;
  private readonly now: () => number;
  private readonly removeNotificationHandler: () => void;
  private readonly removeCloseHandler: () => void;
  private readonly retainClient?: () => (() => void) | undefined;
  private releaseClientRetention?: () => void;
  private disposed = false;

  constructor(
    private readonly client: NativeSubagentMonitorClient,
    private readonly runtime: NativeSubagentMonitorRuntime = defaultRuntime,
    options: MonitorOptions = {},
  ) {
    this.recoveryPollDelaysMs = options.recoveryPollDelaysMs ?? DEFAULT_RECOVERY_POLL_DELAYS_MS;
    this.completionDeliveryRetryDelaysMs =
      options.completionDeliveryRetryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.completionDeliveryMaxRetries =
      options.completionDeliveryMaxRetries ?? this.completionDeliveryRetryDelaysMs.length;
    this.now = options.now ?? Date.now;
    this.retainClient = options.retainClient;
    this.removeNotificationHandler = client.addNotificationHandler(async (notification) => {
      if (!NATIVE_SUBAGENT_NOTIFICATION_METHODS.has(notification.method)) {
        return;
      }
      await this.handleNotification(notification);
    });
    this.removeCloseHandler = client.addCloseHandler(() => this.dispose());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeNotificationHandler();
    this.removeCloseHandler();
    for (const timer of this.taskReconciliationTimers.values()) {
      clearTimeout(timer);
    }
    this.taskReconciliationTimers.clear();
    for (const childState of this.childStates.values()) {
      // Terminal delivery no longer needs app-server. Keep its bounded retry
      // alive if idle-pool eviction closes this client between attempts.
      if (childState.terminal && childState.pendingCompletion) {
        this.clearRecoveryTimers(childState);
        continue;
      }
      this.unregisterChild(childState);
    }
    this.releaseRetainedClient();
    for (const state of this.parentStates.values()) {
      state.ownerCount = 0;
    }
    for (const [parentThreadId] of this.parentStates) {
      if (
        ![...this.childStates.values()].some(
          (childState) => childState.parentThreadId === parentThreadId,
        )
      ) {
        this.parentStates.delete(parentThreadId);
      }
    }
  }

  registerParent(params: {
    parentThreadId: string;
    requesterSessionKey?: string;
    taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
    agentId?: string;
  }): { unregister: () => void } {
    const parentThreadId = params.parentThreadId.trim();
    if (!parentThreadId) {
      throw new Error("Codex native subagent monitor requires a parent thread id");
    }
    if (this.disposed) {
      throw new Error("Codex native subagent monitor is closed");
    }
    let state = this.parentStates.get(parentThreadId);
    if (
      state?.requesterSessionKey &&
      params.requesterSessionKey &&
      state.requesterSessionKey !== params.requesterSessionKey
    ) {
      throw new Error(`Codex thread ${parentThreadId} is already bound to another session`);
    }
    if (!state) {
      state = { parentThreadId, ownerCount: 0 };
      this.parentStates.set(parentThreadId, state);
    }
    state.ownerCount += 1;
    state.requesterSessionKey ??= params.requesterSessionKey;
    state.taskRuntimeScope ??= params.taskRuntimeScope;
    state.agentId ??= params.agentId;
    this.prepareParentTaskRuntime(state);
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId === parentThreadId && childState.pendingCompletion) {
        void this.deliverPendingCompletion(state, childState);
      }
    }
    let registered = true;
    const registeredState = state;
    // Recovery may perform several bounded history reads. It must never delay
    // the foreground parent turn that established this registration.
    void this.reconcileTaskRowsForParent(registeredState).catch((error: unknown) => {
      embeddedAgentLog.warn("Failed to reconcile Codex native subagent task rows", {
        parentThreadId,
        error: formatErrorMessage(error),
      });
    });
    return {
      unregister: () => {
        if (!registered) {
          return;
        }
        registered = false;
        const current = this.parentStates.get(parentThreadId);
        if (current) {
          current.ownerCount -= 1;
          this.pruneParentIfUnused(current);
        }
      },
    };
  }

  private prepareParentTaskRuntime(state: ParentState): void {
    if (!state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    state.taskRuntime ??= this.runtime.createAgentHarnessTaskRuntime({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      scope: state.taskRuntimeScope,
      runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
    });
    state.mirror ??= new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: state.parentThreadId,
        requesterSessionKey: state.requesterSessionKey,
        agentId: state.agentId,
      },
      state.taskRuntime,
    );
  }

  /** Handles one notification from the client-wide router observer. */
  private async handleNotification(notification: CodexServerNotification): Promise<void> {
    if (this.disposed) {
      return;
    }
    const state = this.resolveMirrorState(notification);
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const startedThread = isJsonObject(params?.thread) ? params.thread : undefined;
    const threadId =
      readString(params, "threadId")?.trim() ?? readString(startedThread, "id")?.trim();
    const threadStatus = isJsonObject(params?.status)
      ? normalizeIdentifier(readString(params.status, "type"))
      : undefined;
    const tracksRecoveryRevision = Boolean(threadId && this.threadStatusRevisions.has(threadId));
    if (
      RECOVERY_REVISION_NOTIFICATION_METHODS.has(notification.method) &&
      threadId &&
      tracksRecoveryRevision
    ) {
      this.threadStatusRevisions.get(threadId)!.value += 1;
    }
    if (
      !state &&
      (!threadId ||
        (!this.parentStates.has(threadId) &&
          !this.childStates.has(threadId) &&
          !tracksRecoveryRevision))
    ) {
      return;
    }
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
    const childState = threadId ? this.childStates.get(threadId) : undefined;
    if (notification.method === "turn/started" && childState) {
      this.resumeChild(childState);
    }
    this.captureChildAssistantMessage(notification);
    await this.handleChildTurnCompletion(notification);
    if (notification.method === "thread/status/changed" && threadId && threadStatus) {
      if (threadStatus !== "systemerror") {
        if (childState) {
          this.clearSystemErrorFallback(childState);
        }
      } else {
        if (childState) {
          this.resumeChild(childState, { scheduleRecovery: false });
          this.setRecoveryFallback(
            childState,
            systemErrorFallbackCompletion(childState.childThreadId),
            this.now(),
          );
        }
        void this.reconcileChildThread(threadId)
          .catch((error: unknown) => {
            this.logRecoveryFailure(threadId, error);
            return false;
          })
          .then((reconciled) => {
            if (!reconciled && childState && this.childStates.get(threadId) === childState) {
              this.scheduleRecoveryPoll(childState);
            }
          });
      }
    }
    await this.handleCompletionNotification(notification);
  }

  private resumeChild(childState: ChildState, options: { scheduleRecovery?: boolean } = {}): void {
    if (childState.terminal) {
      return;
    }
    this.observeActiveChild(childState);
    this.clearRecoveryTimers(childState);
    childState.recoveryAttempt = 0;
    if (options.scheduleRecovery !== false) {
      this.scheduleRecoveryPoll(childState);
    }
  }

  private observeActiveChild(childState: ChildState): void {
    childState.settledWithoutCompletion = false;
    childState.fallbackCompletion = undefined;
    this.releaseClientRetention ??= this.retainClient?.();
  }

  private settleResumableChild(childState: ChildState): void {
    if (childState.terminal) {
      return;
    }
    childState.settledWithoutCompletion = true;
    childState.fallbackCompletion = undefined;
    this.clearRecoveryTimers(childState);
    this.releaseClientRetentionIfIdle();
  }

  private captureChildAssistantMessage(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
    if (!childState || childState.terminal) {
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      const turnId = readString(params, "turnId");
      const itemId = readString(params, "itemId");
      const delta = readString(params, "delta");
      if (turnId && itemId && delta) {
        this.recordChildAssistantMessage(childState, turnId, itemId, delta);
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    this.captureChildAssistantMessageItem(
      childState,
      readString(params, "turnId"),
      isJsonObject(params?.item) ? params.item : undefined,
    );
  }

  private captureChildAssistantMessageItem(
    childState: ChildState,
    turnId: string | undefined,
    item: JsonObject | undefined,
  ): void {
    if (readString(item, "type") !== "agentMessage" || !turnId) {
      return;
    }
    const itemId = readString(item, "id");
    if (!itemId) {
      return;
    }
    const messages = this.getChildAssistantMessages(childState, turnId);
    const phase = readString(item, "phase");
    if (phase === "commentary") {
      messages.commentaryIds.add(itemId);
    } else {
      messages.finalMessageIds.add(itemId);
    }
    const text = readString(item, "text");
    if (text) {
      this.recordChildAssistantMessage(childState, turnId, itemId, text, { replace: true });
    }
  }

  private captureChildTurnAssistantMessages(childState: ChildState, turn: JsonObject): void {
    const turnId = readString(turn, "id");
    if (!turnId || !Array.isArray(turn.items)) {
      return;
    }
    for (const item of turn.items) {
      this.captureChildAssistantMessageItem(
        childState,
        turnId,
        isJsonObject(item) ? item : undefined,
      );
    }
  }

  private recordChildAssistantMessage(
    childState: ChildState,
    turnId: string,
    itemId: string,
    text: string,
    options: { replace?: boolean } = {},
  ): void {
    const messages = this.getChildAssistantMessages(childState, turnId);
    if (!messages.texts.has(itemId)) {
      messages.order.push(itemId);
    }
    const existing = messages.texts.get(itemId) ?? "";
    messages.texts.set(itemId, options.replace ? text : `${existing}${text}`);
  }

  private getChildAssistantMessages(
    childState: ChildState,
    turnId: string,
  ): ChildAssistantMessages {
    let messages = childState.assistantMessagesByTurn.get(turnId);
    if (!messages) {
      messages = {
        texts: new Map<string, string>(),
        order: [],
        commentaryIds: new Set<string>(),
        finalMessageIds: new Set<string>(),
      };
      childState.assistantMessagesByTurn.set(turnId, messages);
    }
    return messages;
  }

  private async handleChildTurnCompletion(notification: CodexServerNotification): Promise<void> {
    if (notification.method !== "turn/completed") {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    const turn = isJsonObject(params?.turn) ? params.turn : undefined;
    if (!state || !childState || !turn || childState.terminal) {
      return;
    }
    const turnId = readString(turn, "id");
    if (normalizeIdentifier(readString(turn, "status")) === "interrupted") {
      if (turnId) {
        childState.assistantMessagesByTurn.delete(turnId);
      }
      this.settleResumableChild(childState);
      return;
    }
    this.captureChildTurnAssistantMessages(childState, turn);
    const completion = toChildTurnCompletion(childState, turn);
    if (!completion) {
      return;
    }
    await this.processObservedCompletion(state, childState, completion);
  }

  /** Reads one child through app-server history and delivers a terminal result when present. */
  async reconcileChildThread(childThreadIdInput: string): Promise<boolean> {
    const childState = this.childStates.get(childThreadIdInput.trim());
    if (!childState || childState.terminal || this.disposed) {
      return false;
    }
    if (childState.recoveryInFlight) {
      return await childState.recoveryInFlight;
    }
    const recovery = this.reconcileChildState(childState);
    childState.recoveryInFlight = recovery;
    try {
      return await recovery;
    } finally {
      if (childState.recoveryInFlight === recovery) {
        childState.recoveryInFlight = undefined;
      }
    }
  }

  private resolveMirrorState(notification: CodexServerNotification): ParentState | undefined {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return undefined;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const parentThreadId = readThreadParentThreadId(thread);
      const childThreadId = thread ? readString(thread, "id")?.trim() : undefined;
      const agentPath = readString(readThreadSpawnSource(thread), "agent_path")?.trim();
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && childThreadId && parentThreadId) {
        return this.registerChildThread(
          parentThreadId,
          childThreadId,
          agentPath === undefined ? {} : { agentPath },
        )
          ? state
          : undefined;
      }
      return state;
    }
    if (
      notification.method === "thread/status/changed" ||
      notification.method === "turn/started" ||
      notification.method === "turn/completed" ||
      notification.method === "item/agentMessage/delta"
    ) {
      const childThreadId = readString(params, "threadId")?.trim();
      const parentThreadId = childThreadId
        ? this.childStates.get(childThreadId)?.parentThreadId
        : undefined;
      return parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const parentThreadId = item
        ? (readString(item, "senderThreadId") ?? readString(params, "threadId"))?.trim()
        : undefined;
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && parentThreadId) {
        // Codex multi-agent V2 exposes the child only through this parent-scoped
        // activity item; its later wait item has no receiver thread ids.
        if (
          notification.method === "item/completed" &&
          readString(item, "type") === "subAgentActivity"
        ) {
          const childThreadId = readString(item, "agentThreadId")?.trim();
          const agentPath = readString(item, "agentPath");
          if (childThreadId) {
            this.registerChildThread(
              parentThreadId,
              childThreadId,
              agentPath === undefined ? {} : { agentPath },
            );
          }
          return state;
        }
        const isSpawnAgentTool = normalizeIdentifier(readString(item, "tool")) === "spawnagent";
        const childThreadIds = isSpawnAgentTool
          ? new Set([
              ...readStringArray(item?.receiverThreadIds),
              ...readObjectStringKeys(item?.agentsStates),
            ])
          : new Set(readStringArray(item?.receiverThreadIds));
        let accepted = true;
        for (const childThreadId of childThreadIds) {
          accepted = Boolean(this.registerChildThread(parentThreadId, childThreadId)) && accepted;
        }
        if (!accepted) {
          return undefined;
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
    for (const nativeCompletion of nativeSubagentNotifications.fromNotification(notification)) {
      const childThreadId = this.childThreadIdsByAgentPath.get(
        buildParentAgentPathKey(state.parentThreadId, nativeCompletion.agentPath),
      );
      const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
      if (
        !childState ||
        childState.parentThreadId !== state.parentThreadId ||
        childState.terminal
      ) {
        embeddedAgentLog.warn(
          "Ignoring Codex native subagent completion for unknown child thread",
          {
            parentThreadId: state.parentThreadId,
            agentPath: nativeCompletion.agentPath,
          },
        );
        continue;
      }
      const completion: CodexNativeSubagentCompletion = {
        childThreadId: childState.childThreadId,
        status: nativeCompletion.status,
        statusLabel: nativeCompletion.statusLabel,
        result: nativeCompletion.result,
      };
      await this.processObservedCompletion(state, childState, completion);
    }
  }

  private async processObservedCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
  ): Promise<void> {
    if (!isNoFinalCompletion(completion)) {
      await this.processCompletion(state, childState, completion);
      return;
    }
    this.resumeChild(childState, { scheduleRecovery: false });
    this.setRecoveryFallback(childState, completion, this.now());
    await this.reconcileChildThread(childState.childThreadId).catch((error: unknown) => {
      this.logRecoveryFailure(childState.childThreadId, error);
      return false;
    });
  }

  private async reconcileChildState(childState: ChildState): Promise<boolean> {
    const state = this.parentStates.get(childState.parentThreadId);
    if (!state) {
      return false;
    }
    const statusRead = this.retainThreadStatusRevision(childState.childThreadId);
    try {
      const recovery = await this.readThreadRecovery(childState.childThreadId);
      // Notification handlers run concurrently. A later status transition wins
      // over this read so stale history cannot complete or re-arm the child.
      if (
        !statusRead.isCurrent() ||
        this.childStates.get(childState.childThreadId) !== childState
      ) {
        return false;
      }
      if (recovery.parentThreadId && recovery.parentThreadId !== childState.parentThreadId) {
        embeddedAgentLog.warn("Codex native subagent parent did not match monitor state", {
          childThreadId: childState.childThreadId,
          expectedParentThreadId: childState.parentThreadId,
          actualParentThreadId: recovery.parentThreadId,
        });
        this.unregisterChild(childState);
        return false;
      }
      if (recovery.threadState === "active") {
        this.observeActiveChild(childState);
        return false;
      }
      if (recovery.threadState === "other") {
        this.clearSystemErrorFallback(childState);
      }
      if (recovery.resumable) {
        this.settleResumableChild(childState);
        return false;
      }
      const completion = recovery.completion;
      if (!completion) {
        if (recovery.fallbackCompletion) {
          this.setRecoveryFallback(
            childState,
            recovery.fallbackCompletion,
            recovery.fallbackCompletion.completedAt ?? this.now(),
          );
        }
        return false;
      }
      if (isNoFinalCompletion(completion)) {
        this.setRecoveryFallback(childState, completion, completion.completedAt ?? this.now());
        return false;
      }
      await this.processCompletion(state, childState, completion, completion.completedAt);
      return true;
    } finally {
      statusRead.release();
    }
  }

  private requestThreadRead(childThreadId: string, includeTurns: boolean) {
    return this.client.request(
      "thread/read",
      {
        threadId: childThreadId,
        includeTurns,
      },
      {
        timeoutMs: THREAD_READ_TIMEOUT_MS,
      },
    );
  }

  private requestLatestThreadTurn(childThreadId: string) {
    return this.client.request(
      "thread/turns/list",
      {
        threadId: childThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      },
      { timeoutMs: THREAD_READ_TIMEOUT_MS },
    );
  }

  private async readThreadRecovery(childThreadId: string): Promise<ThreadRecovery> {
    // Fresh threads can expose lineage before includeTurns history is materialized.
    // Register that lineage now so the normal child backoff owns later full reads.
    const response = await this.requestThreadRead(childThreadId, true).catch(() =>
      this.requestThreadRead(childThreadId, false),
    );
    const thread = isJsonObject(response.thread) ? response.thread : undefined;
    if (!thread || readString(thread, "id")?.trim() !== childThreadId) {
      return { resumable: false, threadState: "unavailable" };
    }
    const threadStatus = isJsonObject(thread.status)
      ? normalizeIdentifier(readString(thread.status, "type"))
      : undefined;
    let completion: RecoveredCompletion | undefined;
    let fallbackCompletion: RecoveredCompletion | undefined;
    let resumable = false;
    let threadState: ThreadRecovery["threadState"] =
      threadStatus === "active"
        ? "active"
        : threadStatus === "systemerror"
          ? "system_error"
          : threadStatus
            ? "other"
            : "unavailable";
    if (threadStatus === "systemerror") {
      // The 0.142 protocol floor guarantees the paged history API, whose live
      // snapshot distinguishes the failed current turn from older persisted results.
      const turnsResponse = await this.requestLatestThreadTurn(childThreadId).catch(
        () => undefined,
      );
      const data =
        isJsonObject(turnsResponse) && Array.isArray(turnsResponse.data) ? turnsResponse.data : [];
      const latestTurn = isJsonObject(data[0]) ? data[0] : undefined;
      const latestTurnStatus = normalizeIdentifier(readString(latestTurn, "status"));
      completion =
        latestTurn && latestTurnStatus === "failed"
          ? readTurnCompletion(latestTurn, childThreadId)
          : undefined;
      if (latestTurnStatus === "inprogress") {
        threadState = "active";
      } else if (!completion) {
        // A missing live snapshot must still settle: retry briefly, then report
        // the typed system error instead of pinning the physical client forever.
        fallbackCompletion = systemErrorFallbackCompletion(childThreadId);
      }
    } else if (threadStatus !== "active") {
      const turnRecovery = readThreadTurnRecovery(thread, childThreadId);
      completion = turnRecovery.completion;
      resumable = turnRecovery.resumable;
    }
    return {
      parentThreadId: readThreadParentThreadId(thread),
      completion,
      fallbackCompletion,
      resumable,
      threadState,
    };
  }

  private async processCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number = this.now(),
  ): Promise<void> {
    if (childState.terminal) {
      return;
    }
    if (!this.claimCompletionDelivery(state, childState)) {
      this.unregisterChild(childState);
      return;
    }
    childState.terminal = true;
    this.clearRecoveryTimers(childState);
    state.mirror?.markAuthoritativeCompletion(completion.childThreadId);
    state.taskRuntime?.finalizeTaskRunByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      status: completion.status,
      endedAt: eventAt,
      lastEventAt: eventAt,
      ...(completion.status === "succeeded" ? {} : { error: completion.result }),
      progressSummary: completion.result,
      terminalSummary: completion.result,
    });
    if (!state.requesterSessionKey || !state.taskRuntimeScope) {
      this.unregisterChild(childState);
      return;
    }
    childState.pendingCompletion = completion;
    state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      deliveryStatus: "pending",
    });
    this.releaseClientRetentionIfIdle();
    await this.deliverPendingCompletion(state, childState);
  }

  private async deliverPendingCompletion(
    state: ParentState,
    childState: ChildState,
  ): Promise<void> {
    const completion = childState.pendingCompletion;
    if (!completion || !state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    if (childState.deliveringCompletion || childState.completionDeliveryTimer) {
      return;
    }
    childState.deliveringCompletion = true;
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
        childState.pendingCompletion = undefined;
        childState.completionDeliveryAttempt = 0;
        state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
          runId: codexNativeSubagentRunId(completion.childThreadId),
          deliveryStatus: "delivered",
        });
        this.unregisterChild(childState);
        return;
      }
      const error = delivery.error ?? "completion delivery did not produce a parent response";
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: codexNativeSubagentRunId(completion.childThreadId),
        deliveryStatus: "pending",
        error,
      });
      this.scheduleCompletionDeliveryRetry(childState, error);
    } catch (error) {
      const message = formatErrorMessage(error);
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: codexNativeSubagentRunId(completion.childThreadId),
        deliveryStatus: "pending",
        error: message,
      });
      this.scheduleCompletionDeliveryRetry(childState, message);
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: message,
      });
    } finally {
      childState.deliveringCompletion = false;
    }
  }

  private scheduleCompletionDeliveryRetry(childState: ChildState, error: string): void {
    if (
      !childState.pendingCompletion ||
      childState.completionDeliveryTimer ||
      this.childStates.get(childState.childThreadId) !== childState
    ) {
      return;
    }
    if (childState.completionDeliveryAttempt >= this.completionDeliveryMaxRetries) {
      const state = this.parentStates.get(childState.parentThreadId);
      state?.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: codexNativeSubagentRunId(childState.childThreadId),
        deliveryStatus: "failed",
        error,
      });
      this.unregisterChild(childState);
      return;
    }
    const delayMs = delayForAttempt(
      this.completionDeliveryRetryDelaysMs,
      childState.completionDeliveryAttempt++,
    );
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      if (this.childStates.get(childState.childThreadId) !== childState) {
        return;
      }
      const state = this.parentStates.get(childState.parentThreadId);
      if (state) {
        void this.deliverPendingCompletion(state, childState);
      }
    }, delayMs);
    unrefTimer(childState.completionDeliveryTimer);
  }

  private registerChildThread(
    parentThreadIdInput: string,
    childThreadIdInput: string,
    options: { agentPath?: string } = {},
  ): ChildState | undefined {
    const parentThreadId = parentThreadIdInput.trim();
    const childThreadId = childThreadIdInput.trim();
    if (!parentThreadId || !childThreadId || this.disposed) {
      return undefined;
    }
    let childState = this.childStates.get(childThreadId);
    if (childState && childState.parentThreadId !== parentThreadId) {
      embeddedAgentLog.warn("Ignoring Codex native subagent child reparenting", {
        childThreadId,
        existingParentThreadId: childState.parentThreadId,
        attemptedParentThreadId: parentThreadId,
      });
      return undefined;
    }
    if (!childState) {
      this.releaseClientRetention ??= this.retainClient?.();
      childState = {
        childThreadId,
        parentThreadId,
        agentPathKeys: new Set<string>(),
        assistantMessagesByTurn: new Map<string, ChildAssistantMessages>(),
        recoveryAttempt: 0,
        terminal: false,
        settledWithoutCompletion: false,
        completionDeliveryAttempt: 0,
        deliveringCompletion: false,
      };
      this.childStates.set(childThreadId, childState);
      this.threadStatusRevisions.set(
        childThreadId,
        this.threadStatusRevisions.get(childThreadId) ?? { value: 0, readers: 0 },
      );
    }
    this.registerAgentPath(childState, childThreadId);
    this.parentStates
      .get(parentThreadId)
      ?.mirror?.markAuthoritativeCompletionExpected(childThreadId);
    const agentPath = normalizeOptionalString(options.agentPath);
    if (agentPath) {
      this.registerAgentPath(childState, agentPath);
    }
    this.scheduleRecoveryPoll(childState);
    return childState;
  }

  private registerAgentPath(childState: ChildState, agentPath: string): void {
    const key = buildParentAgentPathKey(childState.parentThreadId, agentPath);
    const existingChild = this.childThreadIdsByAgentPath.get(key);
    if (existingChild && existingChild !== childState.childThreadId) {
      embeddedAgentLog.warn("Ignoring conflicting Codex native subagent agent path", {
        parentThreadId: childState.parentThreadId,
        agentPath,
        existingChildThreadId: existingChild,
        attemptedChildThreadId: childState.childThreadId,
      });
      return;
    }
    this.childThreadIdsByAgentPath.set(key, childState.childThreadId);
    childState.agentPathKeys.add(key);
  }

  private unregisterChild(childState: ChildState): void {
    this.clearRecoveryTimers(childState);
    if (childState.completionDeliveryTimer) {
      clearTimeout(childState.completionDeliveryTimer);
    }
    const deliveryOwnerKey = childState.deliveryOwnerKey;
    if (deliveryOwnerKey && completionDeliveryOwners.get(deliveryOwnerKey) === childState) {
      completionDeliveryOwners.delete(deliveryOwnerKey);
    }
    childState.deliveryOwnerKey = undefined;
    for (const key of childState.agentPathKeys) {
      if (this.childThreadIdsByAgentPath.get(key) === childState.childThreadId) {
        this.childThreadIdsByAgentPath.delete(key);
      }
    }
    if (this.childStates.get(childState.childThreadId) === childState) {
      this.childStates.delete(childState.childThreadId);
    }
    const statusRevision = this.threadStatusRevisions.get(childState.childThreadId);
    if (statusRevision?.readers === 0) {
      this.threadStatusRevisions.delete(childState.childThreadId);
    }
    this.releaseClientRetentionIfIdle();
    const state = this.parentStates.get(childState.parentThreadId);
    if (state) {
      this.pruneParentIfUnused(state);
    }
  }

  private releaseClientRetentionIfIdle(): void {
    if (
      [...this.childStates.values()].some(
        (childState) => !childState.terminal && !childState.settledWithoutCompletion,
      )
    ) {
      return;
    }
    this.releaseRetainedClient();
  }

  private releaseRetainedClient(): void {
    const release = this.releaseClientRetention;
    this.releaseClientRetention = undefined;
    release?.();
  }

  private claimCompletionDelivery(state: ParentState, childState: ChildState): boolean {
    const requesterSessionKey = state.requesterSessionKey?.trim();
    if (!requesterSessionKey) {
      return true;
    }
    const key = `${requesterSessionKey}\0${childState.childThreadId}`;
    const owner = completionDeliveryOwners.get(key);
    if (owner) {
      return owner === childState;
    }
    const runId = codexNativeSubagentRunId(childState.childThreadId);
    if (
      state.taskRuntime
        ?.listTaskRecords()
        .some((task) => task.runId === runId && task.deliveryStatus === "delivered")
    ) {
      return false;
    }
    // Delivery no longer needs the app-server client. Keep one process owner
    // across client replacement so fallback steering cannot inject twice.
    completionDeliveryOwners.set(key, childState);
    childState.deliveryOwnerKey = key;
    return true;
  }

  private pruneParentIfUnused(state: ParentState): void {
    if (state.ownerCount > 0) {
      return;
    }
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId === state.parentThreadId) {
        return;
      }
    }
    if (this.parentStates.get(state.parentThreadId) === state) {
      this.parentStates.delete(state.parentThreadId);
    }
  }

  private scheduleRecoveryPoll(childState: ChildState): void {
    if (
      childState.terminal ||
      childState.settledWithoutCompletion ||
      childState.recoveryTimer ||
      this.disposed ||
      this.recoveryPollDelaysMs.length === 0
    ) {
      return;
    }
    const delayMs = delayForAttempt(this.recoveryPollDelaysMs, childState.recoveryAttempt++);
    childState.recoveryTimer = setTimeout(() => {
      childState.recoveryTimer = undefined;
      void this.reconcileChildThread(childState.childThreadId)
        .catch((error: unknown) => {
          this.logRecoveryFailure(childState.childThreadId, error);
          return false;
        })
        .then(async (reconciled) => {
          if (reconciled || this.childStates.get(childState.childThreadId) !== childState) {
            return;
          }
          const fallback = childState.fallbackCompletion;
          const state = this.parentStates.get(childState.parentThreadId);
          // Give thread/read two persistence windows before delivering the
          // typed no-final result; otherwise a just-written final can be lost.
          if (fallback && state && childState.recoveryAttempt >= 2) {
            await this.processCompletion(
              state,
              childState,
              fallback,
              fallback.completedAt ?? this.now(),
            );
            return;
          }
          this.scheduleRecoveryPoll(childState);
        });
    }, delayMs);
    unrefTimer(childState.recoveryTimer);
  }

  private setRecoveryFallback(
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ): void {
    if (childState.terminal) {
      return;
    }
    const current = childState.fallbackCompletion;
    if (
      current?.status === completion.status &&
      current.statusLabel === completion.statusLabel &&
      current.result === completion.result
    ) {
      return;
    }
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
    childState.recoveryAttempt = 0;
    childState.fallbackCompletion = { ...completion, completedAt: eventAt };
    this.scheduleRecoveryPoll(childState);
  }

  private clearSystemErrorFallback(childState: ChildState): void {
    if (childState.fallbackCompletion?.statusLabel !== "system_error") {
      return;
    }
    childState.fallbackCompletion = undefined;
  }

  private retainThreadStatusRevision(threadId: string): {
    isCurrent: () => boolean;
    release: () => void;
  } {
    const revision = this.threadStatusRevisions.get(threadId) ?? { value: 0, readers: 0 };
    this.threadStatusRevisions.set(threadId, revision);
    revision.readers += 1;
    const capturedValue = revision.value;
    let retained = true;
    return {
      isCurrent: () =>
        this.threadStatusRevisions.get(threadId) === revision && revision.value === capturedValue,
      release: () => {
        if (!retained) {
          return;
        }
        retained = false;
        revision.readers -= 1;
        if (
          revision.readers === 0 &&
          !this.childStates.has(threadId) &&
          this.threadStatusRevisions.get(threadId) === revision
        ) {
          this.threadStatusRevisions.delete(threadId);
        }
      },
    };
  }

  private clearRecoveryTimers(childState: ChildState): void {
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
  }

  private async reconcileTaskRowsForParent(state: ParentState): Promise<void> {
    if (
      this.disposed ||
      this.parentStates.get(state.parentThreadId) !== state ||
      !state.taskRuntime ||
      !state.requesterSessionKey ||
      !state.taskRuntimeScope
    ) {
      return;
    }
    // The scoped runtime already filters runtime, task kind, and run-id prefix.
    // Keep the session check because multiple parents can share one client.
    const candidates = new Map<string, TaskRecoveryCandidate>();
    for (const task of state.taskRuntime.listTaskRecords()) {
      if (
        task.requesterSessionKey !== state.requesterSessionKey ||
        !this.shouldReconcileCodexNativeTask(task)
      ) {
        continue;
      }
      const childThreadId = task.runId!.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length).trim();
      candidates.set(childThreadId, {
        requesterSessionKey: state.requesterSessionKey,
        childThreadId,
        recoveryAttempt: 0,
        taskRuntimeScope: state.taskRuntimeScope,
        agentId: state.agentId,
        taskRuntime: state.taskRuntime,
      });
    }
    for (const candidate of candidates.values()) {
      await this.reconcileTaskCandidate(candidate);
    }
  }

  private async reconcileTaskCandidate(candidate: TaskRecoveryCandidate): Promise<void> {
    const key = `${candidate.requesterSessionKey}\0${candidate.childThreadId}`;
    const scheduled = this.taskReconciliationTimers.get(key);
    if (scheduled) {
      clearTimeout(scheduled);
      this.taskReconciliationTimers.delete(key);
    }
    const existing = this.taskReconciliations.get(key);
    if (existing) {
      await existing;
      return;
    }
    // Hold single-flight through delivery. Releasing after the read lets a slower
    // reconcile recreate a just-pruned child and deliver the same result twice.
    const reconciliation = this.reconcileTaskCandidateOnce(candidate);
    this.taskReconciliations.set(key, reconciliation);
    try {
      await reconciliation;
    } finally {
      if (this.taskReconciliations.get(key) === reconciliation) {
        this.taskReconciliations.delete(key);
      }
    }
  }

  private scheduleTaskCandidateReconciliation(candidate: TaskRecoveryCandidate): void {
    const key = `${candidate.requesterSessionKey}\0${candidate.childThreadId}`;
    if (
      this.disposed ||
      this.recoveryPollDelaysMs.length === 0 ||
      this.taskReconciliationTimers.has(key)
    ) {
      return;
    }
    const delayMs = delayForAttempt(this.recoveryPollDelaysMs, candidate.recoveryAttempt++);
    const timer = setTimeout(() => {
      this.taskReconciliationTimers.delete(key);
      void this.reconcileTaskCandidate(candidate).catch((error: unknown) => {
        this.logRecoveryFailure(candidate.childThreadId, error);
        this.scheduleTaskCandidateReconciliation(candidate);
      });
    }, delayMs);
    this.taskReconciliationTimers.set(key, timer);
    unrefTimer(timer);
  }

  private async reconcileTaskCandidateOnce(candidate: TaskRecoveryCandidate): Promise<void> {
    const runId = codexNativeSubagentRunId(candidate.childThreadId);
    const task = candidate.taskRuntime.listTaskRecords().find((record) => record.runId === runId);
    if (
      !task ||
      task.requesterSessionKey !== candidate.requesterSessionKey ||
      !this.shouldReconcileCodexNativeTask(task)
    ) {
      return;
    }
    const childBeforeRead = this.childStates.get(candidate.childThreadId);
    const statusRead = this.retainThreadStatusRevision(candidate.childThreadId);
    try {
      let recovery: ThreadRecovery;
      try {
        recovery = await this.readThreadRecovery(candidate.childThreadId);
      } catch (error) {
        this.logRecoveryFailure(candidate.childThreadId, error);
        this.scheduleTaskCandidateReconciliation(candidate);
        return;
      }
      if (
        !statusRead.isCurrent() ||
        this.childStates.get(candidate.childThreadId) !== childBeforeRead
      ) {
        this.scheduleTaskCandidateReconciliation(candidate);
        return;
      }
      const parentThreadId = recovery.parentThreadId;
      if (!parentThreadId) {
        this.scheduleTaskCandidateReconciliation(candidate);
        return;
      }
      let state = this.parentStates.get(parentThreadId);
      if (state && state.requesterSessionKey !== candidate.requesterSessionKey) {
        return;
      }
      if (!state) {
        // A requester-scoped task row survives Codex parent rotation. thread/read
        // restores that old lineage; an existing foreign requester above still wins.
        state = {
          parentThreadId,
          ownerCount: 0,
          requesterSessionKey: candidate.requesterSessionKey,
          taskRuntimeScope: candidate.taskRuntimeScope,
          agentId: candidate.agentId,
          taskRuntime: candidate.taskRuntime,
        };
        this.prepareParentTaskRuntime(state);
        this.parentStates.set(parentThreadId, state);
      }
      const childState = this.registerChildThread(parentThreadId, candidate.childThreadId);
      if (!childState) {
        this.pruneParentIfUnused(state);
        return;
      }
      if (recovery.threadState === "active") {
        this.observeActiveChild(childState);
      }
      if (recovery.threadState === "other") {
        this.clearSystemErrorFallback(childState);
      }
      if (recovery.resumable) {
        this.settleResumableChild(childState);
        return;
      }
      const completion = recovery.completion;
      if (!completion) {
        if (recovery.fallbackCompletion) {
          this.setRecoveryFallback(
            childState,
            recovery.fallbackCompletion,
            recovery.fallbackCompletion.completedAt ?? this.now(),
          );
          return;
        }
        this.scheduleRecoveryPoll(childState);
        return;
      }
      if (isNoFinalCompletion(completion)) {
        this.setRecoveryFallback(childState, completion, completion.completedAt ?? this.now());
        return;
      }
      await this.processCompletion(state, childState, completion, completion.completedAt);
    } finally {
      statusRead.release();
    }
  }

  private shouldReconcileCodexNativeTask(task: AgentHarnessTaskRecord): boolean {
    if (
      task.status === "queued" ||
      task.status === "running" ||
      task.deliveryStatus === "pending"
    ) {
      return true;
    }
    if (task.deliveryStatus !== "not_applicable" || task.endedAt === undefined) {
      return false;
    }
    return task.endedAt >= this.now() - RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS;
  }

  private logRecoveryFailure(childThreadId: string, error: unknown): void {
    embeddedAgentLog.debug("Codex native subagent history is not ready", {
      childThreadId,
      error: formatErrorMessage(error),
    });
  }
}

export const codexNativeSubagentMonitorRuntime = { Monitor, register: registerMonitor };

function readThreadTurnRecovery(
  thread: JsonObject,
  childThreadId: string,
): { completion?: RecoveredCompletion; resumable: boolean } {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!isJsonObject(turn)) {
      continue;
    }
    const status = normalizeIdentifier(readString(turn, "status"));
    return {
      completion: readTurnCompletion(turn, childThreadId),
      resumable: status === "interrupted",
    };
  }
  return { resumable: false };
}

function toChildTurnCompletion(
  childState: ChildState,
  turn: JsonObject,
): CodexNativeSubagentCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "completed") {
    const turnId = readString(turn, "id");
    const result = turnId ? lastChildAssistantMessage(childState, turnId) : undefined;
    return {
      childThreadId: childState.childThreadId,
      status: "succeeded",
      statusLabel: result ? "turn_completed" : "completed_without_final_message",
      result: result ?? "Codex native subagent completed without a final assistant message.",
    };
  }
  if (status === "failed") {
    return {
      childThreadId: childState.childThreadId,
      status: "failed",
      statusLabel: "turn_failed",
      result: readTurnErrorMessage(turn) ?? "Codex native subagent failed.",
    };
  }
  return undefined;
}

function lastChildAssistantMessage(childState: ChildState, turnId: string): string | undefined {
  const messages = childState.assistantMessagesByTurn.get(turnId);
  if (!messages) {
    return undefined;
  }
  for (const itemId of messages.order.toReversed()) {
    if (messages.finalMessageIds.has(itemId) && !messages.commentaryIds.has(itemId)) {
      const text = normalizeOptionalString(messages.texts.get(itemId));
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function readTurnErrorMessage(turn: JsonObject): string | undefined {
  const error = isJsonObject(turn.error) ? turn.error : undefined;
  return (
    normalizeOptionalString(readString(error, "message")) ??
    normalizeOptionalString(
      isJsonObject(error?.codexErrorInfo) ? readString(error.codexErrorInfo, "message") : undefined,
    )
  );
}

function systemErrorFallbackCompletion(childThreadId: string): RecoveredCompletion {
  return {
    childThreadId,
    status: "failed",
    statusLabel: "system_error",
    result: "Codex app-server reported a system error for the native subagent thread.",
  };
}

function readTurnCompletion(
  turn: JsonObject,
  childThreadId: string,
): RecoveredCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "inprogress" || !status) {
    return undefined;
  }
  const result = readLastAgentMessage(turn);
  const completedAtSeconds = asFiniteNumber(turn.completedAt);
  const completedAt =
    completedAtSeconds === undefined ? undefined : Math.round(completedAtSeconds * 1_000);
  if (status === "completed") {
    return {
      childThreadId,
      status: "succeeded",
      statusLabel: result ? "task_complete" : "completed_without_final_message",
      result: result ?? "Codex native subagent completed without a final assistant message.",
      completedAt,
    };
  }
  // Codex keeps interrupted subagents resumable. They remain a running task
  // until a later turn reaches an authoritative terminal state.
  if (status === "interrupted") {
    return undefined;
  }
  if (status === "failed") {
    return {
      childThreadId,
      status: "failed",
      statusLabel: "task_failed",
      result: readTurnErrorMessage(turn) ?? result ?? "Codex native subagent failed.",
      completedAt,
    };
  }
  return undefined;
}

function readLastAgentMessage(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  let legacyResult: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isJsonObject(item)) {
      continue;
    }
    if (normalizeIdentifier(readString(item, "type")) !== "agentmessage") {
      continue;
    }
    const text = readString(item, "text")?.trim();
    if (!text) {
      continue;
    }
    const phase = normalizeIdentifier(readString(item, "phase"));
    if (phase === "finalanswer") {
      return text;
    }
    if (!phase) {
      legacyResult ??= text;
    }
  }
  return legacyResult;
}

function buildParentAgentPathKey(parentThreadId: string, agentPath: string): string {
  return `${parentThreadId}\0${agentPath}`;
}

function isNoFinalCompletion(completion: CodexNativeSubagentCompletion): boolean {
  return (
    completion.status === "succeeded" &&
    completion.statusLabel === "completed_without_final_message"
  );
}

function delayForAttempt(delays: readonly number[], attempt: number): number {
  return Math.max(1, delays[Math.min(attempt, delays.length - 1)] ?? 1);
}

function readThreadParentThreadId(thread: JsonObject | undefined): string | undefined {
  return (
    readString(thread, "parentThreadId")?.trim() ??
    readString(readThreadSpawnSource(thread), "parent_thread_id")?.trim()
  );
}

function readThreadSpawnSource(thread: JsonObject | undefined): JsonObject | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  return isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
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
  return isJsonObject(value) ? Object.keys(value).filter((entry) => entry.trim() !== "") : [];
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
