import type {
  BeforeToolCallFailureDisposition,
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import {
  auditNativeToolName,
  auditNativeToolTerminalStatus,
  auditNativeToolUnfinishedStatus,
  itemStatus,
  type CodexNativeToolAuditStatus,
  type CodexNativeToolUnfinishedStatus,
} from "./event-projector-items.js";
import { readItem } from "./event-projector-values.js";
import {
  emitCodexNativePreToolUseFailureDiagnostic,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
import { isCodexNotificationForTurn } from "./notification-correlation.js";
import { readCodexTurn } from "./protocol-validators.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type CodexThreadItem,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

type CodexNativeToolLifecycleContext = Pick<
  EmbeddedRunAttemptParams,
  "agentId" | "runId" | "sessionId" | "sessionKey"
>;

type CodexNativeToolLifecycleProjectorOptions = {
  runAbortSignal?: AbortSignal;
};

type CodexNativePreToolUseFailureRecord = {
  failure: CodexNativePreToolUseFailure;
  terminalReason: CodexNativePreToolUseFailure["disposition"];
};

export type CodexActiveMcpToolCall = {
  id: string;
  server: string;
  tool: string;
  arguments: JsonValue;
};

function isMcpToolCallItemNotification(method: string, params: JsonObject): boolean {
  return (
    (method === "item/started" || method === "item/completed") &&
    isJsonObject(params.item) &&
    params.item.type === "mcpToolCall"
  );
}

/** Owns native item lifetimes for diagnostics and MCP approval correlation. */
export class CodexNativeToolLifecycleProjector {
  private readonly startedAtByItem = new Map<string, number>();
  private readonly activeItems = new Map<
    string,
    {
      toolName: string;
      unfinishedStatus: CodexNativeToolUnfinishedStatus;
      mcpToolCall?: CodexThreadItem;
    }
  >();
  private readonly webSearchCompletionByItem = new Map<
    string,
    { runWasAborted: boolean; sourceTimestampMs?: number }
  >();
  private readonly completedItemIds = new Set<string>();
  private readonly approvalFailureDispositionByItem = new Map<
    string,
    Exclude<BeforeToolCallFailureDisposition, "blocked">
  >();
  private readonly preToolUseFailureByItem = new Map<string, CodexNativePreToolUseFailureRecord>();
  private finalized = false;
  private turnCompleted = false;
  private pendingMcpNotifications = 0;

  constructor(
    private readonly context: CodexNativeToolLifecycleContext,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly options: CodexNativeToolLifecycleProjectorOptions = {},
  ) {}

  getActiveMcpToolCall(serverName: string): CodexActiveMcpToolCall | undefined {
    if (
      this.finalized ||
      this.turnCompleted ||
      this.pendingMcpNotifications > 0 ||
      this.options.runAbortSignal?.aborted
    ) {
      return undefined;
    }
    let candidate: CodexThreadItem | undefined;
    for (const { mcpToolCall } of this.activeItems.values()) {
      if (mcpToolCall?.server !== serverName) {
        continue;
      }
      // Count before validating: excluding an app/plugin or malformed item first
      // could falsely make another call on the same server look unambiguous.
      if (candidate) {
        return undefined;
      }
      candidate = mcpToolCall;
    }
    if (
      !candidate ||
      candidate.status !== "inProgress" ||
      typeof candidate.server !== "string" ||
      !candidate.server.trim() ||
      typeof candidate.tool !== "string" ||
      !candidate.tool.trim() ||
      candidate.arguments === undefined ||
      candidate.appContext != null ||
      candidate.pluginId != null
    ) {
      return undefined;
    }
    return {
      id: candidate.id,
      server: candidate.server,
      tool: candidate.tool,
      arguments: candidate.arguments,
    };
  }

  recordMcpToolCallReceipt(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || !isCodexNotificationForTurn(params, this.threadId, this.turnId)) {
      return;
    }
    // The route's receipt hook precedes its FIFO projection queue. Refuse stale
    // correlation while queued MCP events wait behind asynchronous presentation.
    if (isMcpToolCallItemNotification(notification.method, params)) {
      this.pendingMcpNotifications += 1;
    } else if (
      notification.method === "turn/completed" &&
      readCodexTurn(params.turn)?.id === this.turnId
    ) {
      this.turnCompleted = true;
    }
  }

  handleNotification(notification: CodexServerNotification): void {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params || !isCodexNotificationForTurn(params, this.threadId, this.turnId)) {
      return;
    }
    if (
      this.pendingMcpNotifications > 0 &&
      isMcpToolCallItemNotification(notification.method, params)
    ) {
      this.pendingMcpNotifications -= 1;
    }
    if (notification.method === "turn/completed") {
      const turn = readCodexTurn(params.turn);
      if (!turn || turn.id !== this.turnId) {
        return;
      }
      this.turnCompleted = true;
      for (const item of turn.items ?? []) {
        this.recordSnapshotItem(item);
      }
      return;
    }
    if (notification.method === "rawResponseItem/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      if (item) {
        this.recordRawWebSearchResult(item);
      }
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const item = readItem(params.item);
    if (!item) {
      return;
    }
    this.recordItem({
      phase: notification.method === "item/started" ? "start" : "result",
      item,
      sourceTimestampMs: asDateTimestampMs(
        notification.method === "item/started" ? params.startedAtMs : params.completedAtMs,
      ),
    });
  }

  recordItem(params: {
    phase: "start" | "result";
    item: CodexThreadItem;
    sourceTimestampMs?: number;
  }): void {
    // Malformed MCP starts must still block ambiguous approval correlation.
    const toolName =
      auditNativeToolName(params.item) ??
      (params.item.type === "mcpToolCall" ? params.item.type : undefined);
    if (!toolName || this.completedItemIds.has(params.item.id)) {
      return;
    }
    if (params.phase === "start") {
      this.recordStarted(
        params.item.id,
        toolName,
        auditNativeToolUnfinishedStatus(params.item),
        params.sourceTimestampMs,
        params.item.type === "mcpToolCall" ? params.item : undefined,
      );
      return;
    }
    if (params.item.type === "webSearch") {
      // Warm resumes retain raw-event delivery, while cold resumes expose no
      // capability bit. Wait through the drain; finalization closes misses unknown.
      this.webSearchCompletionByItem.set(params.item.id, {
        runWasAborted: this.options.runAbortSignal?.aborted === true,
        sourceTimestampMs: params.sourceTimestampMs,
      });
      return;
    }

    const itemDurationMs =
      typeof params.item.durationMs === "number" ? params.item.durationMs : undefined;
    this.recordTerminal(params.item.id, toolName, auditNativeToolTerminalStatus(params.item), {
      itemDurationMs,
      sourceTimestampMs: params.sourceTimestampMs,
    });
  }

  recordApprovalFailureDisposition(
    toolCallId: string,
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">,
  ): void {
    if (!this.completedItemIds.has(toolCallId)) {
      this.approvalFailureDispositionByItem.set(toolCallId, disposition);
    }
  }

  recordPreToolUseFailure(
    failure: CodexNativePreToolUseFailure,
    runWasAborted = this.options.runAbortSignal?.aborted === true,
  ): void {
    if (this.completedItemIds.has(failure.toolCallId)) {
      return;
    }
    const record: CodexNativePreToolUseFailureRecord = {
      failure,
      terminalReason:
        runWasAborted && this.options.runAbortSignal
          ? resolveCodexToolAbortTerminalReason(this.options.runAbortSignal)
          : failure.disposition,
    };
    if (this.finalized) {
      // Relay subprocesses can settle after result construction. Emit the
      // item-less fallback here because no later notification drain remains.
      this.completedItemIds.add(failure.toolCallId);
      this.emitPreToolUseFailure(record, failure.toolName, failure.durationMs);
      return;
    }
    this.preToolUseFailureByItem.set(failure.toolCallId, record);
  }

  private recordRawWebSearchResult(item: JsonObject): void {
    if (readString(item, "type") !== "web_search_call") {
      return;
    }
    const toolCallId = readString(item, "id");
    if (!toolCallId || this.completedItemIds.has(toolCallId)) {
      return;
    }
    const toolName = "web_search";
    this.recordStarted(toolCallId, toolName, "unknown");
    const rawStatus = readString(item, "status");
    if (rawStatus === "in_progress" || rawStatus === "running") {
      return;
    }
    const status: CodexNativeToolAuditStatus =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "cancelled"
          ? "cancelled"
          : rawStatus === "failed" || rawStatus === "error" || rawStatus === "incomplete"
            ? "failed"
            : "unknown";
    this.recordTerminal(toolCallId, toolName, status, {
      sourceTimestampMs: this.webSearchCompletionByItem.get(toolCallId)?.sourceTimestampMs,
    });
  }

  private recordTerminal(
    toolCallId: string,
    toolName: string,
    status: CodexNativeToolAuditStatus,
    options: {
      itemDurationMs?: number;
      sourceTimestampMs?: number;
      runWasAborted?: boolean;
    } = {},
  ): void {
    const runWasAborted = options.runWasAborted ?? this.options.runAbortSignal?.aborted === true;
    const preToolUseFailure = this.preToolUseFailureByItem.get(toolCallId);
    this.preToolUseFailureByItem.delete(toolCallId);
    const approvalFailureDisposition = this.approvalFailureDispositionByItem.get(toolCallId);
    this.approvalFailureDispositionByItem.delete(toolCallId);
    this.completedItemIds.add(toolCallId);
    this.activeItems.delete(toolCallId);
    this.webSearchCompletionByItem.delete(toolCallId);
    const startedAt = this.startedAtByItem.get(toolCallId);
    this.startedAtByItem.delete(toolCallId);
    const endedAt = options.sourceTimestampMs ?? Date.now();
    const durationMs =
      options.itemDurationMs ?? (startedAt === undefined ? 0 : Math.max(0, endedAt - startedAt));
    if (preToolUseFailure) {
      this.emitPreToolUseFailure(
        preToolUseFailure,
        toolName,
        durationMs,
        options.sourceTimestampMs,
      );
      return;
    }
    const terminalEvent = approvalFailureDisposition
      ? {
          type: "tool.execution.error" as const,
          durationMs,
          errorCategory: "codex_native_tool_approval",
          terminalReason: approvalFailureDisposition,
        }
      : status === "blocked"
        ? {
            type: "tool.execution.blocked" as const,
            reason: "codex_native_tool_blocked",
            deniedReason: "codex_native_tool_blocked",
          }
        : status === "failed" || status === "cancelled" || status === "unknown"
          ? {
              type: "tool.execution.error" as const,
              durationMs,
              errorCategory:
                status === "unknown"
                  ? "codex_native_tool_outcome_unknown"
                  : status === "cancelled"
                    ? "aborted"
                    : "codex_native_tool_error",
              ...(status === "unknown" ? { errorCode: "tool_outcome_unknown" } : {}),
              terminalReason:
                // An enclosing abort explains unfinished work, but cannot classify
                // a native terminal whose status is absent or unrecognized.
                status === "unknown"
                  ? ("failed" as const)
                  : runWasAborted && this.options.runAbortSignal
                    ? resolveCodexToolAbortTerminalReason(this.options.runAbortSignal)
                    : status === "cancelled"
                      ? ("cancelled" as const)
                      : ("failed" as const),
            }
          : {
              type: "tool.execution.completed" as const,
              durationMs,
            };
    emitTrustedDiagnosticEvent({
      ...this.buildBase(toolCallId, toolName),
      ...terminalEvent,
      ...(options.sourceTimestampMs !== undefined
        ? { sourceTimestampMs: options.sourceTimestampMs }
        : {}),
    });
  }

  finalizeActive(runWasAborted = this.options.runAbortSignal?.aborted === true): void {
    this.finalized = true;
    for (const [toolCallId, { toolName, unfinishedStatus }] of this.activeItems) {
      const webSearchCompletion = this.webSearchCompletionByItem.get(toolCallId);
      const itemRunWasAborted = webSearchCompletion
        ? webSearchCompletion.runWasAborted
        : runWasAborted;
      this.recordTerminal(toolCallId, toolName, unfinishedStatus, {
        runWasAborted: itemRunWasAborted,
        sourceTimestampMs: webSearchCompletion?.sourceTimestampMs,
      });
    }
    for (const [toolCallId, record] of this.preToolUseFailureByItem) {
      if (!this.completedItemIds.has(toolCallId)) {
        this.recordTerminal(toolCallId, record.failure.toolName, "failed", {
          itemDurationMs: record.failure.durationMs,
        });
      }
    }
    this.activeItems.clear();
    this.webSearchCompletionByItem.clear();
    this.approvalFailureDispositionByItem.clear();
    this.preToolUseFailureByItem.clear();
  }

  private emitPreToolUseFailure(
    record: CodexNativePreToolUseFailureRecord,
    toolName: string,
    durationMs: number,
    sourceTimestampMs?: number,
  ): void {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: this.context.agentId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      runId: this.context.runId,
      failure: { ...record.failure, toolName, durationMs },
      terminalReason: record.terminalReason,
      sourceTimestampMs,
    });
  }

  private recordSnapshotItem(item: CodexThreadItem): void {
    if (
      !auditNativeToolName(item) ||
      this.completedItemIds.has(item.id) ||
      itemStatus(item) === "running"
    ) {
      return;
    }
    const toolName = auditNativeToolName(item);
    if (!toolName) {
      return;
    }
    this.recordStarted(item.id, toolName, auditNativeToolUnfinishedStatus(item));
    this.recordItem({ phase: "result", item });
  }

  private recordStarted(
    toolCallId: string,
    toolName: string,
    unfinishedStatus: CodexNativeToolUnfinishedStatus,
    sourceTimestampMs?: number,
    mcpToolCall?: CodexThreadItem,
  ): void {
    if (this.activeItems.has(toolCallId)) {
      return;
    }
    this.startedAtByItem.set(toolCallId, sourceTimestampMs ?? Date.now());
    this.activeItems.set(toolCallId, { toolName, unfinishedStatus, mcpToolCall });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...this.buildBase(toolCallId, toolName),
      ...(sourceTimestampMs !== undefined ? { sourceTimestampMs } : {}),
    });
  }

  private buildBase(toolCallId: string, toolName: string) {
    return {
      agentId: this.context.agentId,
      runId: this.context.runId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      toolName,
      toolCallId,
    };
  }
}
