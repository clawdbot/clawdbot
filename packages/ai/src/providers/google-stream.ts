import type { FinishReason } from "@google/genai";
import { appendAssistantThinking } from "@openclaw/llm-core/event-stream";
import { calculateCost } from "../model-utils.js";
import {
  transportAbortError,
  type WritableTransportStream,
} from "../transports/transport-stream-shared.js";
import type {
  AssistantMessage,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../types.js";
import { notifyLlmRequestActivity } from "../utils/llm-request-activity.js";

// Only Google-owned resource spellings identify the same model.
const GOOGLE_MODEL_RESOURCE_PREFIX =
  /^(?:(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/models\/|google\/|models\/)/u;

export type GoogleStreamChunk = {
  responseId?: string;
  modelVersion?: string;
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
  };
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
    finishReason?: string;
    finishMessage?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
    totalTokenCount?: number;
  };
};

function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (typeof incoming === "string" && incoming.length > 0) {
    return incoming;
  }
  return existing;
}

const stopReasons = new Map<string, StopReason>(
  Object.entries({
    STOP: "stop",
    MAX_TOKENS: "length",
    BLOCKLIST: "error",
    PROHIBITED_CONTENT: "error",
    SPII: "error",
    SAFETY: "error",
    IMAGE_SAFETY: "error",
    IMAGE_PROHIBITED_CONTENT: "error",
    IMAGE_RECITATION: "error",
    IMAGE_OTHER: "error",
    RECITATION: "error",
    FINISH_REASON_UNSPECIFIED: "error",
    OTHER: "error",
    LANGUAGE: "error",
    MALFORMED_FUNCTION_CALL: "error",
    TOO_MANY_TOOL_CALLS: "error",
    UNEXPECTED_TOOL_CALL: "error",
    NO_IMAGE: "error",
  } satisfies Record<FinishReason, StopReason>),
);

function mapStopReason(reason: string): StopReason {
  const mapped = stopReasons.get(reason);
  if (!mapped) {
    throw new Error(`Unhandled stop reason: ${reason}`);
  }
  return mapped;
}

/** @internal Directly tested provider implementation detail. */
export async function consumeGoogleGenerateContentStream(params: {
  chunks: AsyncIterable<GoogleStreamChunk>;
  model: Model;
  output: AssistantMessage;
  stream: WritableTransportStream;
  signal?: AbortSignal;
  nextToolCallId: (name: string | undefined) => string;
  // Preserve the shipped SDK signed-Part and managed SSE delta/error timing contracts.
  profile?: "sdk" | "managed";
  normalizeModelId?: (id: string) => string;
  resolveStopReason?: (reason: string) => StopReason;
}): Promise<void> {
  const preserveParts = params.profile !== "managed";
  const normalizeModelId =
    params.normalizeModelId ?? ((id: string) => id.replace(GOOGLE_MODEL_RESOURCE_PREFIX, ""));
  params.stream.push({ type: "start", partial: params.output });
  let currentBlock: TextContent | ThinkingContent | null = null;
  const blocks = params.output.content;
  let sawTerminalReason = false;
  let terminalGenerationError: (Error & { code: string; type: string }) | undefined;
  const knownUsage = {
    promptTokenCount: 0,
    cachedContentTokenCount: 0,
    toolUsePromptTokenCount: 0,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 0,
  };
  const toolCallIds = new Set<string>();
  for (const block of blocks) {
    if (block.type === "toolCall") {
      toolCallIds.add(block.id);
    }
  }
  const blockIndex = () => blocks.length - 1;

  const endCurrentBlock = () => {
    if (!currentBlock) {
      return;
    }
    if (currentBlock.type === "text") {
      params.stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: currentBlock.text,
        partial: params.output,
      });
    } else {
      params.stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: currentBlock.thinking,
        partial: params.output,
      });
    }
    currentBlock = null;
  };

  for await (const chunk of params.chunks) {
    notifyLlmRequestActivity(params.signal);
    params.output.responseId ||= chunk.responseId;
    const responseModel = chunk.modelVersion?.trim();
    if (responseModel && normalizeModelId(params.model.id) !== normalizeModelId(responseModel)) {
      params.output.responseModel ||= responseModel;
    }
    if (chunk.usageMetadata) {
      for (const field of [
        "promptTokenCount",
        "cachedContentTokenCount",
        "toolUsePromptTokenCount",
        "candidatesTokenCount",
        "thoughtsTokenCount",
      ] as const) {
        const value = chunk.usageMetadata[field];
        if (typeof value === "number") {
          knownUsage[field] = value;
        }
      }
      const promptTokens = knownUsage.promptTokenCount;
      const cacheRead = knownUsage.cachedContentTokenCount;
      const toolUsePromptTokens = knownUsage.toolUsePromptTokenCount;
      const outputTokens = knownUsage.candidatesTokenCount + knownUsage.thoughtsTokenCount;
      params.output.usage = {
        input: Math.max(0, promptTokens - cacheRead) + toolUsePromptTokens,
        output: outputTokens,
        cacheRead,
        cacheWrite: 0,
        totalTokens:
          chunk.usageMetadata.totalTokenCount ?? promptTokens + outputTokens + toolUsePromptTokens,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      };
      calculateCost(params.model, params.output.usage);
    }
    const candidate = chunk.candidates?.[0];
    const promptFeedback = chunk.promptFeedback;
    if (!candidate && promptFeedback) {
      const blockReason =
        (preserveParts
          ? promptFeedback.blockReason
          : promptFeedback.blockReason?.trim() || undefined) ?? "PROMPT_BLOCKED";
      const blockMessage = promptFeedback.blockReasonMessage?.trim();
      if (preserveParts) {
        params.output.errorCode = blockReason;
        params.output.errorType = "google_prompt_blocked";
      }
      throw Object.assign(
        new Error(
          `Google prompt blocked (${blockReason})${blockMessage ? `: ${blockMessage}` : ""}`,
        ),
        { code: blockReason, type: "google_prompt_blocked" },
      );
    }
    if (candidate?.content?.parts) {
      for (const [partIndex, part] of candidate.content.parts.entries()) {
        const text = part.text;
        const hasText = typeof text === "string";
        const hasThoughtSignature =
          typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0;
        const signatureOnly =
          preserveParts &&
          hasThoughtSignature &&
          (!hasText || text.length === 0) &&
          Object.keys(part).every(
            (key) => key === "thought" || key === "thoughtSignature" || key === "text",
          );
        if (signatureOnly || (!preserveParts && hasThoughtSignature && !part.functionCall)) {
          if (!hasText && part.thought !== true) {
            const latestBlock = blocks.at(-1);
            if (
              latestBlock?.type === "toolCall" &&
              (!preserveParts || (partIndex === 0 && !latestBlock.thoughtSignature))
            ) {
              latestBlock.thoughtSignature = retainThoughtSignature(
                latestBlock.thoughtSignature,
                part.thoughtSignature,
              );
              continue;
            }
          }
          // Empty signed Parts have their own wire identity; merging moves an opaque signature.
          if (preserveParts) {
            endCurrentBlock();
          }
        }

        if (
          hasText ||
          signatureOnly ||
          (!preserveParts && hasThoughtSignature && !part.functionCall)
        ) {
          if (preserveParts && currentBlock && (hasThoughtSignature || partIndex > 0)) {
            const currentSignature =
              currentBlock.type === "thinking"
                ? currentBlock.thinkingSignature
                : currentBlock.textSignature;
            const currentText =
              currentBlock.type === "thinking" ? currentBlock.thinking : currentBlock.text;
            if (
              currentText.length > 0 &&
              (currentSignature !== part.thoughtSignature ||
                (partIndex > 0 && (currentSignature || hasThoughtSignature)))
            ) {
              endCurrentBlock();
            }
          }
          const isThinking = part.thought === true || (!preserveParts && !hasText);
          if (
            !currentBlock ||
            (isThinking && currentBlock.type !== "thinking") ||
            (!isThinking && currentBlock.type !== "text")
          ) {
            endCurrentBlock();
            if (isThinking) {
              currentBlock = {
                type: "thinking",
                thinking: "",
                ...(preserveParts ? { thinkingSignature: undefined } : {}),
              };
              params.output.content.push(currentBlock);
              params.stream.push({
                type: "thinking_start",
                contentIndex: blockIndex(),
                partial: params.output,
              });
            } else {
              currentBlock = { type: "text", text: "" };
              params.output.content.push(currentBlock);
              params.stream.push({
                type: "text_start",
                contentIndex: blockIndex(),
                partial: params.output,
              });
            }
          }
          const delta = hasText ? text : "";
          if (currentBlock.type === "thinking") {
            appendAssistantThinking(currentBlock, delta);
            currentBlock.thinkingSignature = retainThoughtSignature(
              currentBlock.thinkingSignature,
              part.thoughtSignature,
            );
            params.stream.push({
              type: "thinking_delta",
              contentIndex: blockIndex(),
              delta,
              partial: params.output,
            });
          } else {
            currentBlock.text += delta;
            currentBlock.textSignature = retainThoughtSignature(
              currentBlock.textSignature,
              part.thoughtSignature,
            );
            params.stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta,
              partial: params.output,
            });
          }
          if (signatureOnly) {
            endCurrentBlock();
          }
        }

        if (part.functionCall) {
          endCurrentBlock();
          const providedId = part.functionCall.id;
          const needsNewId = !providedId || toolCallIds.has(providedId);
          const toolCall: ToolCall = {
            type: "toolCall",
            id: needsNewId ? params.nextToolCallId(part.functionCall.name) : providedId,
            name: part.functionCall.name || "",
            arguments: part.functionCall.args ?? {},
            ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
          };

          params.output.content.push(toolCall);
          toolCallIds.add(toolCall.id);
          params.stream.push({
            type: "toolcall_start",
            contentIndex: blockIndex(),
            partial: params.output,
          });
          params.stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: JSON.stringify(toolCall.arguments),
            partial: params.output,
          });
          params.stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall,
            partial: params.output,
          });
        }
      }
    }

    if (candidate?.finishReason && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") {
      sawTerminalReason = true;
      params.output.stopReason = (params.resolveStopReason ?? mapStopReason)(
        candidate.finishReason,
      );
      if (params.output.stopReason === "error") {
        const finishMessage = candidate.finishMessage?.trim();
        terminalGenerationError = Object.assign(
          new Error(
            `Google generation stopped (${candidate.finishReason})${finishMessage ? `: ${finishMessage}` : ""}`,
          ),
          { code: candidate.finishReason, type: "google_generation_failed" },
        );
      }
      // MAX_TOKENS can leave a complete-looking partial call. Only a normal
      // Google stop may promote parsed calls into an executable tool-use turn.
      if (
        params.output.stopReason === "stop" &&
        params.output.content.some((block) => block.type === "toolCall")
      ) {
        params.output.stopReason = "toolUse";
      }
    }
  }

  endCurrentBlock();

  if (params.signal?.aborted) {
    throw transportAbortError(params.signal);
  }

  if (terminalGenerationError) {
    if (preserveParts) {
      params.output.errorCode = terminalGenerationError.code;
      params.output.errorType = terminalGenerationError.type;
    }
    throw terminalGenerationError;
  }

  if (!sawTerminalReason) {
    if (preserveParts) {
      params.output.errorCode = "STREAM_INCOMPLETE";
      params.output.errorType = "google_incomplete_stream";
    }
    throw Object.assign(new Error("Google stream ended before a terminal finish reason"), {
      code: "STREAM_INCOMPLETE",
      type: "google_incomplete_stream",
    });
  }

  if (params.output.stopReason === "aborted" || params.output.stopReason === "error") {
    throw new Error("An unknown error occurred");
  }

  params.stream.push({
    type: "done",
    reason: params.output.stopReason,
    message: params.output,
  });
  params.stream.end();
}
