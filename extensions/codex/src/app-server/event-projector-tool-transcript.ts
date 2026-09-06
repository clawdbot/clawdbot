import path from "node:path";
import {
  embeddedAgentLog,
  runAgentHarnessAfterToolCallHook,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
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
import {
  isJsonObject,
  type CodexDynamicToolCallOutputContentItem,
  type CodexThreadItem,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import { sanitizeCodexToolArguments } from "./tool-progress-normalization.js";
import type { CodexTrajectoryRecorder } from "./trajectory.js";
import type { CodexTranscriptCheckpointEntry } from "./transcript-checkpoint.js";
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
const NATIVE_PATCH_REJECTION_RE =
  /^\s*patch rejected:\s*writing outside of the project;\s*rejected by user approval settings\s*$/iu;
const CODE_MODE_NATIVE_PATCH_SOURCE_RE =
  /^\s*(?:\/\/[^\r\n]*\r?\n\s*)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.apply_patch\(\s*("(?:\\[\s\S]|[^"\\])*")\s*\)\s*;?\s*text\(\s*\1\s*\)\s*;?\s*$/u;
const CODE_MODE_NATIVE_PATCH_RESULT_RE =
  /^\s*Script (completed|failed)\s*\r?\nWall time\s+\d+(?:\.\d+)?\s+seconds\s*\r?\nOutput:\s*([\s\S]*?)\s*$/iu;
const MAX_TOOL_APPROVAL_REVIEWS = 16;

type ToolApprovalReviewOutcome = "approved" | "denied" | "reviewing";

type ToolApprovalReviewState = {
  reviews: JsonObject[];
  denied: boolean;
  /** `null` means more unresolved IDs existed than the bounded set could retain. */
  unresolvedReviewIds: Set<string> | null;
};

function toolApprovalReviewOutcome(state: ToolApprovalReviewState): ToolApprovalReviewOutcome {
  return state.denied
    ? "denied"
    : state.unresolvedReviewIds === null || state.unresolvedReviewIds.size > 0
      ? "reviewing"
      : "approved";
}

function readCodeModeNativePatchInput(source: unknown): string | undefined {
  if (typeof source !== "string") {
    return undefined;
  }
  const match = CODE_MODE_NATIVE_PATCH_SOURCE_RE.exec(source);
  if (!match?.[2]) {
    return undefined;
  }
  try {
    const patch: unknown = JSON.parse(match[2]);
    return typeof patch === "string" &&
      /^\*\*\* Begin Patch\r?\n[\s\S]*\r?\n\*\*\* End Patch(?:\r?\n)?$/u.test(patch)
      ? patch
      : undefined;
  } catch {
    return undefined;
  }
}

function readInterceptedNativePatchInput(
  command: unknown,
): { input: string; cwd?: string } | undefined {
  if (typeof command !== "string") {
    return undefined;
  }
  const lines = command.replace(/\r\n?/gu, "\n").split("\n");
  const patchStart = lines.indexOf("*** Begin Patch");
  // Nested heredocs and shell expansion can hide extra commands. Trust only
  // a top-level patch, an inert cd, and a single-quoted matching delimiter.
  const invocation =
    /^[\t ]*(?:cd[\t ]+(?:'([^'\n]+)'|([A-Za-z0-9_./-]+))[\t ]+&&[\t ]+)?apply_patch[\t ]*<<-?[\t ]*'([^'\n]+)'[\t ]*$/u.exec(
      lines[0] ?? "",
    );
  if (!invocation || patchStart !== 1) {
    return undefined;
  }
  const patchEnd = lines.indexOf("*** End Patch", patchStart + 1);
  const cwd = invocation[1] ?? invocation[2];
  const delimiter = invocation[3];
  if (
    patchEnd < 0 ||
    lines[patchEnd + 1] !== delimiter ||
    lines.slice(patchEnd + 2).some((line) => line.trim().length > 0)
  ) {
    return undefined;
  }
  return {
    input: `${lines.slice(patchStart, patchEnd + 1).join("\n")}\n`,
    ...(cwd ? { cwd } : {}),
  };
}

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
  private readonly nativeMcpAppResultDetails = new Map<string, unknown>();
  private readonly nativeMcpAppResultDetailsAttempted = new Set<string>();
  private readonly approvalReviewsByCallId = new Map<string, ToolApprovalReviewState>();
  private readonly rawNativeToolOutputByCallId = new Map<string, string>();
  private readonly pendingRawPatchOutputIds = new Set<string>();
  private readonly codeModeNativePatchInputsByCallId = new Map<string, string>();

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly progress: CodexToolProgressProjection,
    private readonly nextTranscriptTimestamp: () => number,
    private readonly options: {
      nativePostToolUseRelayEnabled?: boolean;
      prepareNativeMcpAppResultDetails?: (item: CodexThreadItem) => Promise<unknown>;
      trajectoryRecorder?: CodexTrajectoryRecorder | null;
      checkpointMessage?: (entry: CodexTranscriptCheckpointEntry) => void;
    } = {},
  ) {}

  get transcriptMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  recordToolApprovalReview(
    toolCallId: string,
    reviewId: string,
    status: string,
    review: JsonObject,
  ): ToolApprovalReviewOutcome {
    const state = this.approvalReviewsByCallId.get(toolCallId) ?? {
      reviews: [],
      denied: false,
      unresolvedReviewIds: new Set<string>(),
    };
    state.reviews = [
      ...state.reviews.filter((candidate) => candidate.id !== reviewId),
      review,
    ].slice(-MAX_TOOL_APPROVAL_REVIEWS);
    state.denied ||= ["denied", "timed_out", "aborted"].includes(status);
    const unresolved = state.unresolvedReviewIds;
    if (status === "in_progress") {
      state.unresolvedReviewIds =
        unresolved && (unresolved.size < MAX_TOOL_APPROVAL_REVIEWS || unresolved.has(reviewId))
          ? unresolved.add(reviewId)
          : null;
    } else {
      unresolved?.delete(reviewId);
    }
    this.approvalReviewsByCallId.set(toolCallId, state);
    return toolApprovalReviewOutcome(state);
  }

  finalizeToolApprovalReviews(toolCallId: string): ToolApprovalReviewOutcome | undefined {
    const state = this.approvalReviewsByCallId.get(toolCallId);
    if (!state) {
      return undefined;
    }
    state.unresolvedReviewIds = new Set();
    return toolApprovalReviewOutcome(state);
  }

  recordDynamicToolCall(params: { callId: string; tool: string; arguments?: JsonValue }): void {
    this.recordToolCall({
      id: params.callId,
      name: params.tool,
      arguments: sanitizeCodexToolArguments(params.arguments),
    });
  }

  recordDynamicToolResult(
    params: {
      callId: string;
      tool: string;
      success: boolean;
      contentItems: CodexDynamicToolCallOutputContentItem[];
      details?: unknown;
    },
    resultContentSource?: "network",
  ): void {
    this.recordToolResult({
      id: params.callId,
      name: params.tool,
      text: collectDynamicToolContentText(params.contentItems),
      isError: !params.success,
      details: params.details,
      ...(resultContentSource ? { resultContentSource } : {}),
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

  recordNativeToolResult(item: CodexThreadItem | undefined, details?: unknown): void {
    if (!item || !shouldRecordNativeToolTranscript(item) || this.resultIds.has(item.id)) {
      return;
    }
    const name = itemName(item);
    if (name) {
      const status = itemStatus(item);
      const approvalTimeoutExplanation = this.progress.approvalTimeoutExplanation(item.id, status);
      this.recordToolResult({
        id: item.id,
        name,
        text:
          approvalTimeoutExplanation ??
          this.rawNativeToolOutputByCallId.get(item.id) ??
          itemTranscriptResultText(item, this.progress.outputTextByItem),
        isError: isNonSuccessItemStatus(status),
        details,
        ...(item.type === "webSearch" ? { resultContentSource: "network" } : {}),
      });
      this.progress.approvalTimeoutKinds.delete(item.id);
    }
  }

  recordRawNativeToolItem(item: JsonObject): void {
    const type = typeof item.type === "string" ? item.type : undefined;
    const callId =
      typeof item.call_id === "string"
        ? item.call_id
        : typeof item.callId === "string"
          ? item.callId
          : undefined;
    if (!callId) {
      return;
    }
    if (
      (type === "custom_tool_call" || type === "function_call") &&
      (item.name === "apply_patch" || item.name === "exec_command" || item.name === "exec")
    ) {
      let args: Record<string, unknown> | undefined;
      if (
        type === "custom_tool_call" &&
        item.name === "apply_patch" &&
        typeof item.input === "string"
      ) {
        args = { input: item.input };
      } else if (type === "custom_tool_call" && item.name === "exec") {
        const input = readCodeModeNativePatchInput(item.input);
        if (input) {
          // Successful code-mode patches already emit their own FileChange;
          // retain only the outer call so a pre-emission denial can be linked.
          this.codeModeNativePatchInputsByCallId.set(callId, input);
        }
        return;
      } else if (type === "function_call" && typeof item.arguments === "string") {
        try {
          const parsed: unknown = JSON.parse(item.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const parsedArguments = parsed as Record<string, unknown>;
            if (item.name === "apply_patch") {
              args = parsedArguments;
            } else {
              const command =
                typeof parsedArguments.cmd === "string"
                  ? parsedArguments.cmd
                  : typeof parsedArguments.command === "string"
                    ? parsedArguments.command
                    : undefined;
              const patch = readInterceptedNativePatchInput(command);
              if (patch) {
                const workdir =
                  typeof parsedArguments.workdir === "string"
                    ? parsedArguments.workdir
                    : typeof parsedArguments.cwd === "string"
                      ? parsedArguments.cwd
                      : undefined;
                const cwd = patch.cwd
                  ? workdir && !path.isAbsolute(patch.cwd)
                    ? path.join(workdir, patch.cwd)
                    : patch.cwd
                  : workdir;
                args = { input: patch.input, ...(cwd ? { cwd } : {}) };
              }
            }
          }
        } catch {
          return;
        }
      }
      if (args) {
        this.pendingRawPatchOutputIds.add(callId);
        this.recordToolCall({ id: callId, name: "apply_patch", arguments: args });
      }
      return;
    }
    if (
      (type !== "custom_tool_call_output" && type !== "function_call_output") ||
      (this.namesById.get(callId) !== "apply_patch" &&
        !this.codeModeNativePatchInputsByCallId.has(callId))
    ) {
      return;
    }
    this.pendingRawPatchOutputIds.delete(callId);
    const text =
      typeof item.output === "string"
        ? item.output
        : Array.isArray(item.output)
          ? collectDynamicToolContentText(item.output as CodexThreadItem["contentItems"])
          : "";
    if (!text.trim()) {
      return;
    }
    const codeModePatchInput = this.codeModeNativePatchInputsByCallId.get(callId);
    if (codeModePatchInput) {
      this.codeModeNativePatchInputsByCallId.delete(callId);
      const execution = CODE_MODE_NATIVE_PATCH_RESULT_RE.exec(text);
      if (execution?.[1]?.toLowerCase() === "completed" && execution[2]?.trim() === "{}") {
        // The canonical nested FileChange already owns successful patch audit.
        return;
      }
      if (execution?.[1]?.toLowerCase() === "failed") {
        const failure = execution[2]?.replace(/^Script error:\s*/iu, "").trim() || text;
        this.recordToolCall({
          id: callId,
          name: "apply_patch",
          arguments: { input: codeModePatchInput },
        });
        this.recordToolResult({ id: callId, name: "apply_patch", text: failure, isError: true });
      }
      return;
    }
    this.rawNativeToolOutputByCallId.set(callId, text);
    const result = this.messages.find(
      (message): message is Extract<AgentMessage, { role: "toolResult" }> =>
        message.role === "toolResult" && message.toolCallId === callId,
    );
    if (!result) {
      if (NATIVE_PATCH_REJECTION_RE.test(text)) {
        // Only the upstream's explicit rejection can settle without a native
        // FileChange status; unknown outcomes must remain failed-closed.
        this.recordToolResult({
          id: callId,
          name: "apply_patch",
          text,
          isError: true,
        });
      }
      return;
    }
    // Codex publishes its canonical FileChange terminal item before the
    // model-visible raw output; preserve its authoritative success status.
    const replacement = this.createToolResultMessage({
      id: callId,
      name: "apply_patch",
      text,
      isError: result.isError,
    });
    result.content = replacement.content;
  }

  // Preparation can outlive finalization; the projector owns recording after its close guard.
  async prepareNativeToolResultDetails(item: CodexThreadItem | undefined): Promise<unknown> {
    const preparedDetails = await this.prepareNativeMcpAppResultDetails(item);
    const approvalReviewState = item ? this.approvalReviewsByCallId.get(item.id) : undefined;
    // The terminal tool result is the durable owner for its reviews. Live
    // review events disappear with the run snapshot; details survive history.
    const reviewDetails = approvalReviewState
      ? {
          approvalReviews: approvalReviewState.reviews,
          approvalReviewOutcome: toolApprovalReviewOutcome(approvalReviewState),
        }
      : undefined;
    return reviewDetails
      ? isJsonObject(preparedDetails)
        ? { ...preparedDetails, ...reviewDetails }
        : {
            ...(preparedDetails !== undefined ? { toolDetails: preparedDetails } : {}),
            ...reviewDetails,
          }
      : preparedDetails;
  }

  private async prepareNativeMcpAppResultDetails(
    item: CodexThreadItem | undefined,
  ): Promise<unknown> {
    if (!item || item.type !== "mcpToolCall" || itemStatus(item) === "running") {
      return undefined;
    }
    if (this.nativeMcpAppResultDetails.has(item.id)) {
      return this.nativeMcpAppResultDetails.get(item.id);
    }
    if (
      this.nativeMcpAppResultDetailsAttempted.has(item.id) ||
      !this.options.prepareNativeMcpAppResultDetails
    ) {
      return undefined;
    }
    this.nativeMcpAppResultDetailsAttempted.add(item.id);
    try {
      const details = await this.options.prepareNativeMcpAppResultDetails(item);
      if (details !== undefined) {
        this.nativeMcpAppResultDetails.set(item.id, details);
      }
      return details;
    } catch (error) {
      embeddedAgentLog.debug("codex native MCP App preview preparation failed", {
        itemId: item.id,
        error,
      });
      return undefined;
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
    const output =
      this.progress.approvalTimeoutExplanation(params.item.id, params.status) ??
      itemOutputText(params.item, this.progress.outputTextByItem);
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
    const error =
      this.progress.approvalTimeoutExplanation(item.id, status) ??
      itemToolError(item, status, this.progress.outputTextByItem);
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
    terminalDisposition: "prompt_error" | "tool_error" | "diagnostic_only";
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
          details: { reason: "missing_tool_result" },
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
    if (params.terminalDisposition === "tool_error") {
      this.recordMissingToolError(missingTranscriptIds, missingTrajectoryIds);
      return undefined;
    }
    if (params.terminalDisposition === "diagnostic_only") {
      return undefined;
    }
    const missingCount = new Set([...missingTranscriptIds, ...missingTrajectoryIds]).size;
    return missingCount === 1
      ? MISSING_TOOL_RESULT_ERROR
      : `${MISSING_TOOL_RESULT_ERROR} missingToolResultCount=${missingCount}`;
  }

  async readMirroredSessionMessages(signal?: AbortSignal): Promise<AgentMessage[]> {
    return (
      (await readCodexMirroredSessionHistoryMessages(
        {
          agentId: this.params.agentId,
          sessionFile: this.params.sessionFile,
          sessionId: this.params.sessionId,
          sessionKey: this.params.sessionKey,
          sessionTarget: this.params.sessionTarget,
        },
        undefined,
        "native-evidence",
        signal,
      )) ?? []
    );
  }

  private recordToolCall(params: ToolTranscriptCallInput): void {
    if (!params.id || !params.name || this.callIds.has(params.id)) {
      return;
    }
    this.callIds.add(params.id);
    this.namesById.set(params.id, params.name);
    this.progress.recordTranscriptCall(params);
    const message = attachCodexMirrorIdentity(
      this.createToolCallMessage(params),
      `${this.turnId}:tool:${params.id}:call`,
    );
    this.messages.push(message);
    this.options.checkpointMessage?.({ read: () => message });
  }

  private recordToolResult(params: ToolTranscriptResultInput): void {
    if (!params.id || !params.name || this.resultIds.has(params.id)) {
      return;
    }
    this.resultIds.add(params.id);
    this.progress.recordTranscriptResult(params);
    const message = attachCodexMirrorIdentity(
      this.createToolResultMessage(params),
      `${this.turnId}:tool:${params.id}:result`,
    );
    this.messages.push(message);
    this.options.checkpointMessage?.({
      read: () => message,
      // A linked raw patch output enriches FileChange after item/completed.
      // Keep that result mutable only until the promised raw output arrives.
      ready: () => !this.pendingRawPatchOutputIds.has(params.id),
    });
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
    this.progress.setLastToolError({
      toolName: name,
      ...(meta ? { meta } : {}),
      error: formatMissingToolResultError({ id: firstMissingId, name }),
      ...(item && isMutatingNativeToolItem(item) ? { mutatingAction: true } : {}),
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

  private createToolResultMessage(
    params: ToolTranscriptResultInput,
  ): Extract<AgentMessage, { role: "toolResult" }> {
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
      ...(params.details !== undefined ? { details: params.details } : {}),
      ...(params.resultContentSource
        ? { __openclaw: { resultContentSource: params.resultContentSource } }
        : {}),
      timestamp: this.nextTranscriptTimestamp(),
    } as unknown as Extract<AgentMessage, { role: "toolResult" }>;
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
