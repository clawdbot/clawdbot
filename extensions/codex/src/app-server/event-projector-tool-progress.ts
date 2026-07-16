import {
  inferToolMetaFromArgs,
  TOOL_PROGRESS_OUTPUT_MAX_CHARS,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptResult,
  type ToolProgressDetailMode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  isMutatingNativeToolItem,
  isNonSuccessItemStatus,
  isSideEffectingNativeToolItem,
  itemName,
  itemStatus,
} from "./event-projector-items.js";
import {
  itemMeta,
  itemOutputText,
  itemToolArgs,
  itemToolError,
  nativeToolActionFingerprint,
} from "./event-projector-tool-items.js";
import {
  collectDynamicToolContentText,
  formatToolOutput,
  formatToolSummary,
  MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM,
  normalizeToolTranscriptArguments,
  TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS,
  TOOL_PROGRESS_ECHO_SIGNATURE_CAP,
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
  ToolOutputAccumulator,
  toolOutputRawEchoSignature,
  truncateToolTranscriptText,
} from "./event-projector-tool-output.js";
import { readString } from "./event-projector-values.js";
import type {
  CodexDynamicToolCallOutputContentItem,
  CodexThreadItem,
  JsonObject,
} from "./protocol.js";
import { resolveCodexToolProgressDetailMode } from "./tool-progress-normalization.js";

const TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES = new Set([
  "message",
  "messages",
  "reply",
  "send",
  "reaction",
  "react",
  "typing",
]);

export function shouldEmitTranscriptToolProgress(toolName: unknown, _args?: unknown): boolean {
  const normalized = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  return Boolean(normalized && !TRANSCRIPT_PROGRESS_SUPPRESSED_TOOL_NAMES.has(normalized));
}

export type ToolTranscriptCallInput = {
  id: string;
  name: string;
  arguments?: unknown;
};

export type ToolTranscriptResultInput = {
  id: string;
  name: string;
  text?: string;
  isError: boolean;
};

type ToolProgressRawSignature = { length: number; prefix: string };
type ToolProgressEchoState = {
  displayTexts: string[];
  streamedDisplayText?: string;
  streamedRawSignature?: ToolProgressRawSignature;
  rawSignatures: ToolProgressRawSignature[];
};

export class CodexToolProgressProjection {
  private readonly echoesByItem = new Map<string, ToolProgressEchoState>();
  private readonly resultSummaryItemIds = new Set<string>();
  private readonly resultOutputItemIds = new Set<string>();
  private readonly resultOutputStreamedItemIds = new Set<string>();
  private readonly transcriptProgressSuppressedIds = new Set<string>();
  private readonly transcriptArgumentsById = new Map<string, unknown>();
  private readonly resultOutputDeltaState = new Map<
    string,
    { chars: number; messages: number; truncated: boolean }
  >();
  private readonly output = new ToolOutputAccumulator();
  private readonly metas = new Map<string, EmbeddedRunAttemptResult["toolMetas"][number]>();
  private readonly sideEffectingNativeIds = new Set<string>();
  private readonly sideEffectingDynamicIds = new Set<string>();
  private readonly transcriptProgressCallIds = new Set<string>();
  private lastNativeToolError: EmbeddedRunAttemptResult["lastToolError"];

  constructor(private readonly params: EmbeddedRunAttemptParams) {}

  get outputTextByItem(): ReadonlyMap<string, string> {
    return this.output.textByItem;
  }

  get toolMetas(): EmbeddedRunAttemptResult["toolMetas"] {
    return [...this.metas.values()];
  }

  getToolMeta(itemId: string): EmbeddedRunAttemptResult["toolMetas"][number] | undefined {
    return this.metas.get(itemId);
  }

  get lastToolError(): EmbeddedRunAttemptResult["lastToolError"] {
    return this.lastNativeToolError;
  }

  get hasPotentialSideEffects(): boolean {
    return this.sideEffectingNativeIds.size > 0 || this.sideEffectingDynamicIds.size > 0;
  }

  setLastToolError(error: EmbeddedRunAttemptResult["lastToolError"]): void {
    if (!error) {
      this.lastNativeToolError = undefined;
      return;
    }
    const terminalResolution = this.params.observeToolTerminal?.({
      toolName: error.toolName,
      ...(error.meta ? { meta: error.meta } : {}),
      outcome: "failure",
      failure: {
        ...(error.errorCode ? { errorCode: error.errorCode } : {}),
        ...(error.error ? { error: error.error } : {}),
        ...(error.validationErrorSummary
          ? { validationErrorSummary: error.validationErrorSummary }
          : {}),
        ...(error.timedOut ? { timedOut: true } : {}),
        ...(error.middlewareError ? { middlewareError: true } : {}),
      },
      nativeMutation: {
        mutatingAction: error.mutatingAction === true,
        replaySafe: error.mutatingAction !== true,
        ...(error.actionFingerprint ? { actionFingerprint: error.actionFingerprint } : {}),
        ...(error.fileTarget ? { fileTarget: error.fileTarget } : {}),
      },
    });
    this.lastNativeToolError =
      terminalResolution?.lastToolError ??
      (this.lastNativeToolError?.mutatingAction && error.mutatingAction !== true
        ? this.lastNativeToolError
        : error);
  }

  recordDynamicToolResult(params: {
    callId: string;
    tool: string;
    asyncStarted?: boolean;
    terminalResolution?: ReturnType<NonNullable<EmbeddedRunAttemptParams["observeToolTerminal"]>>;
    success: boolean;
    terminalType?: "blocked" | "completed" | "error";
    sideEffectEvidence?: boolean;
    contentItems: CodexDynamicToolCallOutputContentItem[];
  }): void {
    const resultText = collectDynamicToolContentText(params.contentItems);
    const existing = this.metas.get(params.callId);
    this.metas.set(params.callId, {
      toolName: existing?.toolName ?? params.tool,
      ...(existing?.meta ? { meta: existing.meta } : {}),
      ...(params.asyncStarted === true ? { asyncStarted: true } : {}),
      ...(!params.success ? { isError: true } : {}),
    });
    if (params.terminalResolution) {
      this.lastNativeToolError = params.terminalResolution.lastToolError;
    } else if (!params.success) {
      this.lastNativeToolError = {
        toolName: params.tool,
        error:
          resultText ||
          (params.terminalType === "blocked"
            ? "codex dynamic tool blocked"
            : "codex dynamic tool failed"),
      };
    } else if (this.lastNativeToolError?.mutatingAction !== true) {
      this.lastNativeToolError = undefined;
    }
    if (params.sideEffectEvidence === true) {
      this.sideEffectingDynamicIds.add(params.callId);
    }
  }

  handleOutputDelta(params: JsonObject, toolName: string): void {
    const itemId = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (!itemId || !delta) {
      return;
    }
    const storedOutput = this.output.append(itemId, delta);
    this.rememberEcho(itemId, {
      displayText: storedOutput.text,
      rawLength: storedOutput.normalizedLength,
      rawPrefix: storedOutput.rawPrefix,
      streamedDisplay: true,
    });
    if (!this.shouldEmitToolOutput()) {
      return;
    }
    if (
      this.transcriptProgressSuppressedIds.has(itemId) ||
      !shouldEmitTranscriptToolProgress(toolName, this.transcriptArgumentsById.get(itemId))
    ) {
      return;
    }
    const state = this.resultOutputDeltaState.get(itemId) ?? {
      chars: 0,
      messages: 0,
      truncated: false,
    };
    if (state.truncated) {
      return;
    }
    const remainingChars = Math.max(0, TOOL_PROGRESS_OUTPUT_MAX_CHARS - state.chars);
    const remainingMessages = Math.max(0, MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM - state.messages);
    if (remainingChars === 0 || remainingMessages === 0) {
      state.truncated = true;
      this.resultOutputDeltaState.set(itemId, state);
      this.emitToolResultMessage({
        itemId,
        text: formatToolOutput(toolName, undefined, "(output truncated)"),
      });
      return;
    }
    const chunk = delta.length > remainingChars ? truncateUtf16Safe(delta, remainingChars) : delta;
    state.chars += chunk.length;
    state.messages += 1;
    const reachedLimit =
      delta.length > remainingChars ||
      state.chars >= TOOL_PROGRESS_OUTPUT_MAX_CHARS ||
      state.messages >= MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM;
    if (reachedLimit) {
      state.truncated = true;
    }
    this.resultOutputDeltaState.set(itemId, state);
    this.resultOutputStreamedItemIds.add(itemId);
    this.emitToolResultMessage({
      itemId,
      text: formatToolOutput(
        toolName,
        undefined,
        reachedLimit ? `${chunk}\n...(truncated)...` : chunk,
      ),
    });
  }

  recordNativeToolError(params: {
    item: CodexThreadItem;
    name: string;
    meta?: string;
    status: ReturnType<typeof itemStatus>;
  }): void {
    const executionStarted = params.status !== "blocked";
    const mutatingAction = executionStarted && isMutatingNativeToolItem(params.item);
    const actionFingerprint = mutatingAction ? nativeToolActionFingerprint(params.item) : undefined;
    const isFailure = isNonSuccessItemStatus(params.status);
    const error = isFailure
      ? itemToolError(params.item, params.status, this.output.textByItem)
      : undefined;
    const terminalResolution = this.params.observeToolTerminal?.({
      toolCallId: params.item.id,
      toolName: params.name,
      arguments: itemToolArgs(params.item),
      ...(params.meta ? { meta: params.meta } : {}),
      executionStarted,
      outcome: isFailure ? "failure" : "success",
      ...(isFailure ? { failure: error ? { error } : {} } : {}),
      nativeMutation: {
        mutatingAction,
        replaySafe: !mutatingAction,
        ...(actionFingerprint ? { actionFingerprint } : {}),
      },
    });
    if (terminalResolution) {
      this.lastNativeToolError = terminalResolution.lastToolError;
      return;
    }
    if (isFailure) {
      this.lastNativeToolError = {
        toolName: params.name,
        ...(params.meta ? { meta: params.meta } : {}),
        ...(error ? { error } : {}),
        ...(mutatingAction ? { mutatingAction: true } : {}),
        ...(actionFingerprint ? { actionFingerprint } : {}),
      };
    } else if (this.lastNativeToolError?.mutatingAction !== true) {
      this.lastNativeToolError = undefined;
    }
  }

  emitToolResultSummary(item: CodexThreadItem | undefined): void {
    if (!item || !this.params.onToolResult || !this.shouldEmitToolResult()) {
      return;
    }
    if (this.resultSummaryItemIds.has(item.id)) {
      return;
    }
    const toolName = itemName(item);
    if (!toolName || !shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) {
      return;
    }
    this.resultSummaryItemIds.add(item.id);
    this.emitToolResultMessage({
      itemId: item.id,
      text: formatToolSummary(toolName, itemMeta(item, this.toolProgressDetailMode())),
    });
  }

  emitToolResultOutput(item: CodexThreadItem | undefined): void {
    if (!item || !this.params.onToolResult || !this.shouldEmitToolOutput()) {
      return;
    }
    if (this.resultOutputItemIds.has(item.id) || this.resultOutputStreamedItemIds.has(item.id)) {
      return;
    }
    const toolName = itemName(item);
    const output = itemOutputText(item, this.output.textByItem);
    if (!toolName || !output || !shouldEmitTranscriptToolProgress(toolName, itemToolArgs(item))) {
      return;
    }
    this.emitToolResultMessage({
      itemId: item.id,
      text: formatToolOutput(toolName, itemMeta(item, this.toolProgressDetailMode()), output),
      finalOutput: true,
      isError: isNonSuccessItemStatus(itemStatus(item)),
    });
  }

  recordToolMeta(item: CodexThreadItem | undefined): void {
    if (!item) {
      return;
    }
    if (isSideEffectingNativeToolItem(item)) {
      this.sideEffectingNativeIds.add(item.id);
    } else {
      this.sideEffectingNativeIds.delete(item.id);
    }
    const toolName = itemName(item);
    if (!toolName) {
      return;
    }
    const meta = itemMeta(item, this.toolProgressDetailMode());
    const status = itemStatus(item);
    const existing = this.metas.get(item.id);
    this.metas.set(item.id, {
      toolName,
      ...(meta ? { meta } : {}),
      ...(existing?.asyncStarted ? { asyncStarted: true } : {}),
      ...(status !== "running" && isNonSuccessItemStatus(status) ? { isError: true } : {}),
    });
  }

  recordTranscriptCall(params: ToolTranscriptCallInput): void {
    this.transcriptArgumentsById.set(params.id, params.arguments);
    if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) {
      this.transcriptProgressSuppressedIds.add(params.id);
    } else {
      this.transcriptProgressSuppressedIds.delete(params.id);
    }
    this.emitTranscriptToolCallProgress(params);
  }

  recordTranscriptResult(params: ToolTranscriptResultInput): void {
    this.emitTranscriptToolResultProgress(params);
  }

  matchesEcho(text: string): boolean {
    for (const state of this.echoesByItem.values()) {
      if (state.streamedDisplayText === text || state.displayTexts.includes(text)) {
        return true;
      }
      if (
        state.streamedRawSignature &&
        text.length === state.streamedRawSignature.length &&
        text.startsWith(state.streamedRawSignature.prefix)
      ) {
        return true;
      }
      for (const signature of state.rawSignatures) {
        if (text.length === signature.length && text.startsWith(signature.prefix)) {
          return true;
        }
      }
    }
    return false;
  }

  rememberCommandAggregateOutputEcho(item: CodexThreadItem | undefined): void {
    if (item?.type !== "commandExecution" || typeof item.aggregatedOutput !== "string") {
      return;
    }
    const signature = toolOutputRawEchoSignature(item.aggregatedOutput);
    if (signature) {
      this.rememberEcho(item.id, signature);
    }
  }

  toolProgressDetailMode(): ToolProgressDetailMode {
    return resolveCodexToolProgressDetailMode(this.params.toolProgressDetail);
  }

  private emitToolResultMessage(params: {
    itemId: string;
    text: string;
    finalOutput?: boolean;
    isError?: boolean;
  }): void {
    const rawText = params.text.trim();
    const text = truncateToolTranscriptText(rawText);
    if (!text) {
      return;
    }
    this.rememberEcho(params.itemId, { displayText: text, rawText });
    if (params.finalOutput) {
      this.resultOutputItemIds.add(params.itemId);
    }
    try {
      void Promise.resolve(
        this.params.onToolResult?.({
          text,
          ...(params.isError === true ? { isError: true } : {}),
        }),
      ).catch(() => {});
    } catch {
      // Tool progress delivery is best-effort and should not affect the turn.
    }
  }

  private shouldEmitToolResult(): boolean {
    return typeof this.params.shouldEmitToolResult === "function"
      ? this.params.shouldEmitToolResult()
      : this.params.verboseLevel === "on" || this.params.verboseLevel === "full";
  }

  private shouldEmitToolOutput(): boolean {
    return typeof this.params.shouldEmitToolOutput === "function"
      ? this.params.shouldEmitToolOutput()
      : this.params.verboseLevel === "full";
  }

  private emitTranscriptToolCallProgress(params: ToolTranscriptCallInput): void {
    if (!shouldEmitTranscriptToolProgress(params.name, params.arguments)) {
      return;
    }
    this.transcriptProgressCallIds.add(params.id);
    const args = normalizeToolTranscriptArguments(params.arguments);
    const meta = inferToolMetaFromArgs(params.name, args, {
      detailMode: this.toolProgressDetailMode(),
    });
    if (
      !this.params.onToolResult ||
      !this.shouldEmitToolResult() ||
      this.resultSummaryItemIds.has(params.id) ||
      this.resultOutputStreamedItemIds.has(params.id)
    ) {
      return;
    }
    this.resultSummaryItemIds.add(params.id);
    this.emitToolResultMessage({
      itemId: params.id,
      text: formatToolSummary(params.name, meta),
    });
  }

  private emitTranscriptToolResultProgress(params: ToolTranscriptResultInput): void {
    if (
      this.transcriptProgressSuppressedIds.has(params.id) ||
      !shouldEmitTranscriptToolProgress(params.name, this.transcriptArgumentsById.get(params.id))
    ) {
      return;
    }
    if (!this.transcriptProgressCallIds.has(params.id)) {
      this.emitTranscriptToolCallProgress({ id: params.id, name: params.name, arguments: {} });
    }
    if (
      !this.params.onToolResult ||
      !this.shouldEmitToolOutput() ||
      this.resultOutputItemIds.has(params.id) ||
      this.resultOutputStreamedItemIds.has(params.id)
    ) {
      return;
    }
    const text = params.text?.trim();
    if (text) {
      this.emitToolResultMessage({
        itemId: params.id,
        text: formatToolOutput(params.name, undefined, text),
        finalOutput: true,
        isError: params.isError,
      });
    }
  }

  private rememberEcho(
    itemId: string,
    signature: {
      displayText?: string;
      rawText?: string;
      rawLength?: number;
      rawPrefix?: string;
      streamedDisplay?: boolean;
    },
  ): void {
    if (!itemId) {
      return;
    }
    const existing = this.echoesByItem.get(itemId) ?? { displayTexts: [], rawSignatures: [] };
    const displayText = signature.displayText?.trim();
    if (displayText) {
      if (signature.streamedDisplay) {
        existing.streamedDisplayText = displayText;
      } else if (!existing.displayTexts.includes(displayText)) {
        if (existing.displayTexts.length >= TOOL_PROGRESS_ECHO_SIGNATURE_CAP) {
          existing.displayTexts.shift();
        }
        existing.displayTexts.push(displayText);
      }
    }
    const rawText = signature.rawText?.trim();
    const rawLength = signature.rawLength ?? rawText?.length;
    const rawPrefix = signature.rawPrefix?.trim() ?? rawText;
    if (
      rawLength !== undefined &&
      rawPrefix &&
      rawPrefix.length >= TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS
    ) {
      const next: ToolProgressRawSignature = {
        length: rawLength,
        prefix: rawPrefix.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS),
      };
      if (signature.streamedDisplay) {
        existing.streamedRawSignature = next;
      } else {
        const matchIndex = existing.rawSignatures.findIndex(
          (entry) => entry.prefix === next.prefix,
        );
        if (matchIndex >= 0) {
          existing.rawSignatures[matchIndex] = next;
        } else {
          if (existing.rawSignatures.length >= TOOL_PROGRESS_ECHO_SIGNATURE_CAP) {
            existing.rawSignatures.shift();
          }
          existing.rawSignatures.push(next);
        }
      }
    }
    this.echoesByItem.set(itemId, existing);
  }
}
