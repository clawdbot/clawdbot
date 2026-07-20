import {
  runAgentHarnessAfterToolCallHook,
  type AgentMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Usage } from "openclaw/plugin-sdk/llm";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  isMutatingNativeToolItem,
  isNonSuccessItemStatus,
  itemName,
  itemStatus,
  shouldRecordNativeToolTranscript,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import {
  isNativePostToolUseRelayItem,
  itemMeta,
  itemOutputText,
  itemToolArgs,
  itemToolError,
  itemToolResult,
  itemTranscriptResultText,
  nativeToolActionFingerprint,
} from "./event-projector-tool-items.js";
import {
  collectDynamicToolContentText,
  normalizeToolTranscriptArguments,
  truncateToolTranscriptText,
} from "./event-projector-tool-output.js";
import {
  CodexToolProgressProjection,
  type ToolTranscriptCallInput,
  type ToolTranscriptResultInput,
} from "./event-projector-tool-progress.js";
import { resolveCodexLocalRuntimeAttribution } from "./local-runtime-attribution.js";
import type {
  CodexDynamicToolCallOutputContentItem,
  CodexThreadItem,
  JsonValue,
} from "./protocol.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { sanitizeCodexToolArguments } from "./tool-progress-normalization.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const MISSING_TOOL_RESULT_ERROR =
  "OpenClaw recorded a native Codex tool.call without a matching tool.result before the turn completed.";

export class CodexToolTranscriptProjection {
  private readonly messages: AgentMessage[] = [];
  private readonly callIds = new Set<string>();
  private readonly resultIds = new Set<string>();
  private readonly namesById = new Map<string, string>();
  private readonly trajectoryCallIds = new Set<string>();
  private readonly trajectoryResultIds = new Set<string>();
  private readonly trajectoryNamesById = new Map<string, string>();
  private readonly trajectoryItemsById = new Map<string, CodexThreadItem>();
  private readonly afterToolCallObservedItemIds = new Set<string>();

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly progress: CodexToolProgressProjection,
    private readonly nextTranscriptTimestamp: () => number,
    private readonly options: {
      nativePostToolUseRelayEnabled?: boolean;
      trajectoryRecorder?: CodexTrajectoryRecorder | null;
    } = {},
  ) {}

  get transcriptMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    this.recordToolCall({
      id: params.callId,
      name: params.tool,
      arguments: sanitizeCodexToolArguments(params.arguments),
    });
  }

  recordDynamicToolResult(params: {
    callId: string;
    tool: string;
    success: boolean;
    contentItems: CodexDynamicToolCallOutputContentItem[];
  }): void {
    this.recordToolResult({
      id: params.callId,
      name: params.tool,
      text: collectDynamicToolContentText(params.contentItems),
      isError: !params.success,
    });
  }

  recordNativeToolCall(item: CodexThreadItem | undefined): void {
    if (!item || !shouldRecordNativeToolTranscript(item)) {
      return;
    }
    const name = itemName(item);
    if (name) {
      this.recordToolCall({ id: item.id, name, arguments: itemToolArgs(item) });
    }
  }

  recordNativeToolResult(item: CodexThreadItem | undefined): void {
    if (!item || !shouldRecordNativeToolTranscript(item)) {
      return;
    }
    const name = itemName(item);
    if (name) {
      this.recordToolResult({
        id: item.id,
        name,
        text: itemTranscriptResultText(item, this.progress.outputTextByItem),
        isError: isNonSuccessItemStatus(itemStatus(item)),
      });
    }
  }

  recordTrajectoryEvent(params: {
    phase: "start" | "result";
    item: CodexThreadItem;
    name: string;
    args?: Record<string, unknown>;
    status: ReturnType<typeof itemStatus>;
  }): void {
    if (params.phase === "start") {
      this.trajectoryCallIds.add(params.item.id);
      this.trajectoryNamesById.set(params.item.id, params.name);
      this.trajectoryItemsById.set(params.item.id, params.item);
      this.options.trajectoryRecorder?.recordEvent("tool.call", {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: params.item.id,
        toolCallId: params.item.id,
        name: params.name,
        arguments: params.args,
      });
      return;
    }
    this.trajectoryResultIds.add(params.item.id);
    const toolResult = itemToolResult(params.item).result;
    const output = itemOutputText(params.item, this.progress.outputTextByItem);
    this.options.trajectoryRecorder?.recordEvent("tool.result", {
      threadId: this.threadId,
      turnId: this.turnId,
      itemId: params.item.id,
      toolCallId: params.item.id,
      name: params.name,
      status: params.status,
      isError: isNonSuccessItemStatus(params.status),
      ...(toolResult ? { result: toolResult } : {}),
      ...(output ? { output } : {}),
    });
  }

  emitAfterToolCallObservation(item: CodexThreadItem): void {
    if (!this.shouldEmitAfterToolCallObservation(item)) {
      return;
    }
    const name = itemName(item);
    const status = itemStatus(item);
    if (!name || status === "running") {
      return;
    }
    this.afterToolCallObservedItemIds.add(item.id);
    const result = itemToolResult(item).result;
    const error = itemToolError(item, status, this.progress.outputTextByItem);
    const startedAt = resolveStartedAtFromDurationMs(item.durationMs);
    const hookParams = {
      toolName: name,
      toolCallId: item.id,
      runId: this.params.runId,
      agentId: this.params.agentId,
      sessionId: this.params.sessionId,
      sessionKey: this.params.sessionKey,
      startArgs: itemToolArgs(item) ?? {},
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
    setImmediate(() => {
      void runAgentHarnessAfterToolCallHook(hookParams);
    });
  }

  synthesizeMissingToolResults(params: {
    synthesize: boolean;
    recordPromptError: boolean;
  }): string | undefined {
    if (!params.synthesize) {
      return undefined;
    }
    const missingTranscriptIds = [...this.callIds].filter((id) => !this.resultIds.has(id));
    const missingTrajectoryIds = [...this.trajectoryCallIds].filter(
      (id) => !this.trajectoryResultIds.has(id),
    );
    if (missingTranscriptIds.length === 0 && missingTrajectoryIds.length === 0) {
      return undefined;
    }
    for (const id of missingTranscriptIds) {
      const name = this.namesById.get(id) ?? this.trajectoryNamesById.get(id);
      if (name) {
        this.recordToolResult({
          id,
          name,
          text: formatMissingToolResultError({ id, name }),
          isError: true,
        });
      }
    }
    for (const id of missingTrajectoryIds) {
      const name = this.trajectoryNamesById.get(id) ?? this.namesById.get(id);
      if (!name) {
        continue;
      }
      this.trajectoryResultIds.add(id);
      const text = formatMissingToolResultError({ id, name });
      this.options.trajectoryRecorder?.recordEvent("tool.result", {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: id,
        toolCallId: id,
        name,
        status: "failed",
        isError: true,
        result: { status: "failed", reason: "missing_tool_result" },
        output: text,
      });
    }
    if (!params.recordPromptError) {
      this.recordMissingToolError(missingTranscriptIds, missingTrajectoryIds);
      return undefined;
    }
    const missingCount = new Set([...missingTranscriptIds, ...missingTrajectoryIds]).size;
    return missingCount === 1
      ? MISSING_TOOL_RESULT_ERROR
      : `${MISSING_TOOL_RESULT_ERROR} missingToolResultCount=${missingCount}`;
  }

  async readMirroredSessionMessages(): Promise<AgentMessage[]> {
    return (
      (await readCodexMirroredSessionHistoryMessages({
        agentId: this.params.agentId,
        sessionFile: this.params.sessionFile,
        sessionId: this.params.sessionId,
        sessionKey: this.params.sessionKey,
      })) ?? []
    );
  }

  private recordToolCall(params: ToolTranscriptCallInput): void {
    if (!params.id || !params.name || this.callIds.has(params.id)) {
      return;
    }
    this.callIds.add(params.id);
    this.namesById.set(params.id, params.name);
    this.progress.recordTranscriptCall(params);
    this.messages.push(
      attachCodexMirrorIdentity(
        this.createToolCallMessage(params),
        `${this.turnId}:tool:${params.id}:call`,
      ),
    );
  }

  private recordToolResult(params: ToolTranscriptResultInput): void {
    if (!params.id || !params.name || this.resultIds.has(params.id)) {
      return;
    }
    this.resultIds.add(params.id);
    this.progress.recordTranscriptResult(params);
    this.messages.push(
      attachCodexMirrorIdentity(
        this.createToolResultMessage(params),
        `${this.turnId}:tool:${params.id}:result`,
      ),
    );
  }

  private recordMissingToolError(
    missingTranscriptIds: string[],
    missingTrajectoryIds: string[],
  ): void {
    const firstMissingId =
      missingTranscriptIds.find((id) => Boolean(this.namesById.get(id))) ??
      missingTrajectoryIds.find((id) =>
        Boolean(this.trajectoryNamesById.get(id) ?? this.namesById.get(id)),
      );
    if (!firstMissingId) {
      return;
    }
    const name = this.namesById.get(firstMissingId) ?? this.trajectoryNamesById.get(firstMissingId);
    if (!name) {
      return;
    }
    const item = this.trajectoryItemsById.get(firstMissingId);
    const meta = item
      ? itemMeta(item, this.progress.toolProgressDetailMode())
      : this.progress.getToolMeta(firstMissingId)?.meta;
    const actionFingerprint = item ? nativeToolActionFingerprint(item) : undefined;
    this.progress.setLastToolError({
      toolName: name,
      ...(meta ? { meta } : {}),
      error: formatMissingToolResultError({ id: firstMissingId, name }),
      ...(item && isMutatingNativeToolItem(item) ? { mutatingAction: true } : {}),
      ...(actionFingerprint ? { actionFingerprint } : {}),
    });
  }

  private shouldEmitAfterToolCallObservation(item: CodexThreadItem): boolean {
    if (
      !shouldSynthesizeToolProgressForItem(item) ||
      this.afterToolCallObservedItemIds.has(item.id)
    ) {
      return false;
    }
    return !(this.options.nativePostToolUseRelayEnabled && isNativePostToolUseRelayItem(item));
  }

  private createToolCallMessage(params: ToolTranscriptCallInput): AgentMessage {
    const args = normalizeToolTranscriptArguments(params.arguments);
    const attribution = resolveCodexLocalRuntimeAttribution(this.params);
    return {
      role: "assistant",
      content: [
        { type: "toolCall", id: params.id, name: params.name, arguments: args, input: args },
      ],
      api: attribution.api ?? "openai-chatgpt-responses",
      provider: attribution.provider,
      model: this.params.modelId,
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: this.nextTranscriptTimestamp(),
    } as unknown as AgentMessage;
  }

  private createToolResultMessage(params: ToolTranscriptResultInput): AgentMessage {
    const text = truncateToolTranscriptText(params.text?.trim() || toolResultStatusText(params));
    return {
      role: "toolResult",
      toolCallId: params.id,
      toolName: params.name,
      isError: params.isError,
      content: [
        {
          type: "toolResult",
          id: params.id,
          name: params.name,
          toolName: params.name,
          toolCallId: params.id,
          toolUseId: params.id,
          tool_use_id: params.id,
          content: text,
          text,
        },
      ],
      timestamp: this.nextTranscriptTimestamp(),
    } as unknown as AgentMessage;
  }
}

function formatMissingToolResultError(params: { id: string; name: string }): string {
  return `${MISSING_TOOL_RESULT_ERROR} toolCallId=${params.id}; toolName=${params.name}`;
}

function toolResultStatusText(params: ToolTranscriptResultInput): string {
  return params.isError ? `${params.name} failed` : `${params.name} completed`;
}

function resolveStartedAtFromDurationMs(durationMs: unknown): number | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return undefined;
  }
  return asDateTimestampMs(Date.now() - Math.max(0, durationMs));
}
