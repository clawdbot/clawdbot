/** Trusted turn-level model-call diagnostics for the Claude Code CLI runtime. */
import crypto from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticErrorMessage,
} from "../../infra/diagnostic-error-metadata.js";
import { hasInternalDiagnosticEventListeners } from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEventWithPrivateData,
  type DiagnosticEventPrivateData,
  type DiagnosticModelCallContent,
} from "../../infra/diagnostic-events.js";
import {
  cloneDiagnosticContentValue,
  resolveDiagnosticModelContentCapturePolicy,
} from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { CliOutput, CliUsage } from "../cli-output.js";
import { isFailoverError } from "../failover-error.js";
import type { PreparedCliRunContext } from "./types.js";

type TrustedDiagnosticEventInput = Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0];
type ModelCallFailureKind = Extract<
  TrustedDiagnosticEventInput,
  { type: "model.call.error" }
>["failureKind"];

const MAX_CAPTURED_CONTENT_BYTES = 128 * 1024;
const FALLBACK_RESPONSE_RESERVE_BYTES = 16 * 1024;
const MAX_CAPTURED_OUTPUT_MESSAGES = 200;
const MAX_CAPTURED_OUTPUT_BLOCKS = 200;
const TRUNCATED_CONTENT_SUFFIX = "...(truncated)";
// One maximal tool-call block per envelope plus stopReason is the largest
// structure possible under the shared 200-envelope/item caps.
const MAX_CAPTURED_OUTPUT_STRUCTURE_BYTES = Buffer.byteLength(
  JSON.stringify(
    Array.from({ length: MAX_CAPTURED_OUTPUT_MESSAGES }, () => ({
      role: "assistant",
      content: [{ type: "tool_call", name: "", id: "" }],
      stopReason: "",
    })),
  ),
  "utf8",
);

type DiagnosticContentBudget = {
  remainingBytes: number;
  remainingItems: number;
  fallbackReserveBytes: number;
  fallbackReserveItems: number;
  truncated: boolean;
};

function serializedStringContentBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

const TRUNCATED_CONTENT_SUFFIX_BYTES = serializedStringContentBytes(TRUNCATED_CONTENT_SUFFIX);

function truncateSerializedStringSafe(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (serializedStringContentBytes(value) <= maxBytes) {
    return value;
  }
  let low = 0;
  let high = Math.min(value.length, maxBytes);
  let captured = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf16Safe(value, middle);
    if (serializedStringContentBytes(candidate) <= maxBytes) {
      captured = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return captured;
}

function releaseFallbackReserve(budget: DiagnosticContentBudget): void {
  budget.remainingBytes += budget.fallbackReserveBytes;
  budget.remainingItems += budget.fallbackReserveItems;
  budget.fallbackReserveBytes = 0;
  budget.fallbackReserveItems = 0;
}

function captureTextWithinBudget(
  value: string,
  budget: DiagnosticContentBudget,
): string | undefined {
  if (budget.remainingBytes <= 0) {
    budget.truncated = true;
    return undefined;
  }
  const valueBytes = serializedStringContentBytes(value);
  if (valueBytes <= budget.remainingBytes) {
    budget.remainingBytes -= valueBytes;
    return value;
  }
  const suffix = truncateSerializedStringSafe(TRUNCATED_CONTENT_SUFFIX, budget.remainingBytes);
  const prefixBudget = Math.max(0, budget.remainingBytes - serializedStringContentBytes(suffix));
  const captured = `${truncateSerializedStringSafe(value, prefixBudget)}${suffix}`;
  budget.remainingBytes -= serializedStringContentBytes(captured);
  budget.truncated = true;
  return captured;
}

function captureBoundedText(value: string): string {
  const budget = {
    remainingBytes: MAX_CAPTURED_CONTENT_BYTES,
    remainingItems: 1,
    fallbackReserveBytes: 0,
    fallbackReserveItems: 0,
    truncated: false,
  };
  return captureTextWithinBudget(value, budget) ?? "";
}

function assistantContentBlock(
  block: unknown,
  budget: DiagnosticContentBudget,
): Record<string, unknown> | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
    const text = captureTextWithinBudget(block.text, budget);
    return text === undefined ? undefined : { type: "text", text };
  }
  if (block.type === "thinking" && typeof block.thinking === "string") {
    const thinking = captureTextWithinBudget(block.thinking, budget);
    return thinking === undefined ? undefined : { type: "thinking", thinking };
  }
  if (
    (block.type === "tool_use" ||
      block.type === "server_tool_use" ||
      block.type === "mcp_tool_use") &&
    typeof block.name === "string"
  ) {
    const name = captureTextWithinBudget(block.name, budget);
    if (name === undefined) {
      return undefined;
    }
    const id = typeof block.id === "string" ? captureTextWithinBudget(block.id, budget) : undefined;
    return {
      type: "tool_call",
      name,
      ...(id !== undefined ? { id } : {}),
    };
  }
  return undefined;
}

function isCapturableAssistantContentBlock(block: unknown): boolean {
  if (!isRecord(block)) {
    return false;
  }
  return (
    (block.type === "text" && typeof block.text === "string") ||
    (block.type === "thinking" && typeof block.thinking === "string") ||
    ((block.type === "tool_use" ||
      block.type === "server_tool_use" ||
      block.type === "mcp_tool_use") &&
      typeof block.name === "string")
  );
}

function isTextAssistantContentBlock(block: unknown): boolean {
  return (
    isRecord(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.length > 0
  );
}

function assistantMessageHasText(message: unknown): boolean {
  if (!isRecord(message)) {
    return false;
  }
  if (typeof message.content === "string") {
    return message.content.length > 0;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  const limit = Math.min(message.content.length, MAX_CAPTURED_OUTPUT_BLOCKS);
  for (let index = 0; index < limit; index += 1) {
    if (isTextAssistantContentBlock(message.content[index])) {
      return true;
    }
  }
  return false;
}

// Claude's assistant envelopes can contain native tool arguments and opaque
// thinking signatures. Keep only the visible response blocks OpenClaw can
// represent accurately; external harness tool spans stay metadata-only.
function normalizeClaudeAssistantMessage(
  message: unknown,
  budget: DiagnosticContentBudget,
): Record<string, unknown> | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const content: Record<string, unknown>[] = [];
  if (typeof message.content === "string") {
    if (message.content.length === 0) {
      return undefined;
    }
    releaseFallbackReserve(budget);
    const text = captureTextWithinBudget(message.content, budget);
    if (text !== undefined && budget.remainingItems > 0) {
      content.push({ type: "text", text });
      budget.remainingItems -= 1;
    } else if (text !== undefined) {
      budget.truncated = true;
    }
  } else if (Array.isArray(message.content)) {
    const sourceBlocks = message.content.slice(0, MAX_CAPTURED_OUTPUT_BLOCKS);
    if (sourceBlocks.length < message.content.length) {
      budget.truncated = true;
    }
    for (const [index, sourceBlock] of sourceBlocks.entries()) {
      if (isTextAssistantContentBlock(sourceBlock)) {
        releaseFallbackReserve(budget);
      }
      const block = assistantContentBlock(sourceBlock, budget);
      if (block) {
        if (budget.remainingItems > 0) {
          content.push(block);
          budget.remainingItems -= 1;
        } else {
          budget.truncated = true;
        }
      }
      if (budget.remainingBytes <= 0 || budget.remainingItems <= 0) {
        if (sourceBlocks.slice(index + 1).some(isCapturableAssistantContentBlock)) {
          budget.truncated = true;
        }
        break;
      }
    }
  }
  if (content.length === 0) {
    return undefined;
  }
  const stopReason =
    typeof message.stop_reason === "string"
      ? captureTextWithinBudget(message.stop_reason, budget)
      : undefined;
  return {
    role: "assistant",
    content,
    ...(stopReason !== undefined ? { stopReason } : {}),
  };
}

function hasTextContent(messages: readonly Record<string, unknown>[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block) =>
          isRecord(block) &&
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.length > 0,
      ),
  );
}

function appendOutputTruncationMarker(messages: Record<string, unknown>[]): void {
  const marker = { type: "text", text: TRUNCATED_CONTENT_SUFFIX };
  if (messages.length < MAX_CAPTURED_OUTPUT_MESSAGES) {
    messages.push({ role: "assistant", content: [marker] });
    return;
  }
  const lastIndex = messages.length - 1;
  const lastMessage = messages[lastIndex];
  messages[lastIndex] = {
    ...lastMessage,
    content: [...(Array.isArray(lastMessage?.content) ? lastMessage.content : []), marker],
  };
}

function privateData(params: {
  modelContent?: DiagnosticModelCallContent;
  errorMessage?: string;
}): DiagnosticEventPrivateData | undefined {
  if (!params.modelContent && !params.errorMessage) {
    return undefined;
  }
  return {
    ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
    ...(params.modelContent ? { modelContent: params.modelContent } : {}),
  };
}

function failureKindForClaudeCli(
  error: unknown,
  abortSignal: AbortSignal | undefined,
): ModelCallFailureKind | undefined {
  if (isFailoverError(error) && error.reason === "timeout") {
    return "timeout";
  }
  const inferred = diagnosticErrorFailureKind(error);
  if (inferred) {
    return inferred;
  }
  return abortSignal?.aborted ? "aborted" : undefined;
}

function usageField(usage: CliUsage | undefined): { usage?: CliUsage } {
  return usage ? { usage } : {};
}

/** Creates one exactly-once Claude CLI model-call lifecycle for a prepared turn. */
export function createClaudeCliModelCallDiagnostics(params: {
  context: PreparedCliRunContext;
  prompt: string;
  systemPrompt?: string;
  transport: "paired-node-cli" | "stdio" | "stdio-live";
  now?: () => number;
}) {
  // Listener registration is process-stable after plugin startup. This attempt-local
  // snapshot avoids trace ids, capture buffers, and byte accounting when nobody consumes them.
  if (
    params.context.backendResolved.id !== "claude-cli" ||
    !areDiagnosticsEnabledForProcess() ||
    !hasInternalDiagnosticEventListeners()
  ) {
    return undefined;
  }

  const now = params.now ?? (() => Date.now());
  const capture = resolveDiagnosticModelContentCapturePolicy(
    params.context.params.config ?? params.context.contextEngineConfig,
  );
  const contextWindow = params.context.contextWindowInfo;
  const trace = freezeDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope());
  const baseFields = {
    runId: params.context.params.runId,
    callId: `${params.context.params.runId}:claude-cli:${crypto.randomUUID()}`,
    ...(params.context.params.sessionKey ? { sessionKey: params.context.params.sessionKey } : {}),
    sessionId: params.context.params.sessionId,
    provider:
      params.context.backendResolved.modelProvider ??
      params.context.params.modelProvider ??
      "anthropic",
    model: params.context.normalizedModel,
    api: "claude-code",
    transport: params.transport,
    observationUnit: "turn" as const,
    ...(contextWindow
      ? {
          contextTokenBudget: contextWindow.tokens,
          contextWindowSource: contextWindow.source,
          ...(contextWindow.referenceTokens
            ? { contextWindowReferenceTokens: contextWindow.referenceTokens }
            : {}),
        }
      : {}),
    promptStats: {
      inputMessagesCount: 1,
      inputMessagesChars: params.prompt.length,
      ...(params.systemPrompt ? { systemPromptChars: params.systemPrompt.length } : {}),
      totalChars: params.prompt.length + (params.systemPrompt?.length ?? 0),
    },
    trace,
  };
  const capturedAssistantMessages: Record<string, unknown>[] = [];
  const outputContentBudget: DiagnosticContentBudget = {
    remainingBytes:
      MAX_CAPTURED_CONTENT_BYTES -
      MAX_CAPTURED_OUTPUT_STRUCTURE_BYTES -
      TRUNCATED_CONTENT_SUFFIX_BYTES -
      FALLBACK_RESPONSE_RESERVE_BYTES,
    // One item stays available for the truncation marker; one more is held
    // separately for the final visible fallback until normal text arrives.
    remainingItems: MAX_CAPTURED_OUTPUT_BLOCKS - 2,
    fallbackReserveBytes: FALLBACK_RESPONSE_RESERVE_BYTES,
    fallbackReserveItems: 1,
    truncated: false,
  };
  let started = false;
  let terminalEmitted = false;
  let startedAt = 0;
  let requestPayloadBytes: number | undefined;
  let responseStreamBytes = 0;
  let firstCliOutputAt: number | undefined;
  let observedUsage: CliUsage | undefined;
  let observedTerminalUsage: CliUsage | undefined;

  const baseModelContent = (): DiagnosticModelCallContent | undefined => {
    if (!capture.anyModelContent) {
      return undefined;
    }
    const content: DiagnosticModelCallContent = {
      ...(capture.inputMessages
        ? {
            inputMessages: cloneDiagnosticContentValue([
              {
                role: "user",
                content: [{ type: "text", text: captureBoundedText(params.prompt) }],
              },
            ]),
          }
        : {}),
      ...(capture.systemPrompt && params.systemPrompt
        ? { systemPrompt: captureBoundedText(params.systemPrompt) }
        : {}),
    };
    return Object.keys(content).length > 0 ? content : undefined;
  };
  const outputMessages = (output?: CliOutput): unknown => {
    const messages = capturedAssistantMessages.slice();
    const responseText = output?.rawText ?? output?.text;
    if (
      !hasTextContent(messages) &&
      responseText &&
      messages.length < MAX_CAPTURED_OUTPUT_MESSAGES
    ) {
      const fallback = normalizeClaudeAssistantMessage(
        { content: responseText },
        outputContentBudget,
      );
      if (fallback) {
        messages.push(fallback);
      }
    }
    if (outputContentBudget.truncated) {
      appendOutputTruncationMarker(messages);
    }
    return cloneDiagnosticContentValue(messages);
  };
  const completedModelContent = (output?: CliOutput): DiagnosticModelCallContent | undefined => {
    const base = baseModelContent();
    if (!capture.outputMessages) {
      return base;
    }
    return {
      ...base,
      outputMessages: outputMessages(output),
    };
  };
  const sizeTimingFields = () => ({
    ...(requestPayloadBytes !== undefined ? { requestPayloadBytes } : {}),
    ...(responseStreamBytes > 0 ? { responseStreamBytes } : {}),
    ...(firstCliOutputAt !== undefined
      ? { timeToFirstByteMs: Math.max(0, firstCliOutputAt - startedAt) }
      : {}),
  });

  return {
    emitStarted: (): void => {
      if (started) {
        return;
      }
      started = true;
      startedAt = now();
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.started",
          ...baseFields,
        },
        privateData({ modelContent: baseModelContent() }),
      );
    },
    observeRequestPayload: (payload: string): void => {
      requestPayloadBytes = Buffer.byteLength(payload, "utf8");
    },
    observeCliOutput: (
      chunk: string,
      stream: "stderr" | "stdout",
      knownByteLength?: number,
    ): void => {
      if (!chunk) {
        return;
      }
      firstCliOutputAt ??= now();
      if (stream === "stdout") {
        responseStreamBytes += knownByteLength ?? Buffer.byteLength(chunk, "utf8");
      }
    },
    observeAssistantMessage: (message: unknown): void => {
      if (
        !capture.outputMessages ||
        ((outputContentBudget.remainingBytes <= 0 || outputContentBudget.remainingItems <= 0) &&
          !(outputContentBudget.fallbackReserveItems > 0 && assistantMessageHasText(message))) ||
        capturedAssistantMessages.length >= MAX_CAPTURED_OUTPUT_MESSAGES - 1
      ) {
        if (capture.outputMessages) {
          outputContentBudget.truncated = true;
        }
        return;
      }
      const normalized = normalizeClaudeAssistantMessage(message, outputContentBudget);
      if (normalized) {
        capturedAssistantMessages.push(normalized);
      }
    },
    observeUsage: (usage: CliUsage, terminal: boolean): void => {
      observedUsage = usage;
      if (terminal) {
        observedTerminalUsage = usage;
      }
    },
    emitCompleted: (output: CliOutput): void => {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.completed",
          ...baseFields,
          durationMs: Math.max(0, now() - startedAt),
          ...sizeTimingFields(),
          ...usageField(
            output.diagnosticUsage ?? observedTerminalUsage ?? output.usage ?? observedUsage,
          ),
        },
        privateData({ modelContent: completedModelContent(output) }),
      );
    },
    emitError: (error: unknown): void => {
      if (!started || terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      const failureKind = failureKindForClaudeCli(error, params.context.params.abortSignal);
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "model.call.error",
          ...baseFields,
          durationMs: Math.max(0, now() - startedAt),
          errorCategory:
            (isFailoverError(error) ? error.reason : undefined) ??
            failureKind ??
            diagnosticErrorCategory(error),
          ...(failureKind ? { failureKind } : {}),
          ...sizeTimingFields(),
          ...usageField(observedTerminalUsage ?? observedUsage),
        },
        privateData({
          modelContent: completedModelContent(),
          errorMessage: diagnosticErrorMessage(error),
        }),
      );
    },
  };
}
