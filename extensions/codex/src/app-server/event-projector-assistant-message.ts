import {
  formatErrorMessage,
  type NormalizedUsage,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage, Usage } from "openclaw/plugin-sdk/llm";
import type { CodexProviderRefusal } from "./event-projector-values.js";
import {
  resolveCodexLocalRuntimeAttribution,
  type CodexLocalRuntimeAttributionParams,
} from "./local-runtime-attribution.js";

type CodexAssistantMessageParams = CodexLocalRuntimeAttributionParams &
  Pick<AgentHarnessAttemptParamsV2, "modelId">;
type CodexAssistantAttribution = {
  provider: string;
  modelId: string;
  api?: AssistantMessage["api"];
};

type CodexAssistantUsage = Usage & {
  // Codex is a managed runtime; keep reasoning telemetry private to managed consumers.
  reasoningTokens?: number;
};

export type AssistantMessageOptions = {
  tokenUsage: NormalizedUsage | undefined;
  aborted: boolean;
  promptError: unknown;
  providerRefusal?: CodexProviderRefusal;
};

export type CodexAsyncAssistantMessage = AssistantMessage & {
  openclawAsyncDelivery: { itemId: string };
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export function createAssistantMessage(
  params: CodexAssistantMessageParams,
  text: string,
  options: AssistantMessageOptions,
): AssistantMessage {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return createAttributedCodexAssistantMessage(
    { ...attribution, modelId: params.modelId },
    text,
    options,
  );
}

/** Creates a Codex assistant row when a bounded call already owns attribution. */
export function createAttributedCodexAssistantMessage(
  attribution: CodexAssistantAttribution,
  text: string,
  options: AssistantMessageOptions,
): AssistantMessage {
  const usage: CodexAssistantUsage = options.tokenUsage
    ? {
        input: options.tokenUsage.input ?? 0,
        output: options.tokenUsage.output ?? 0,
        cacheRead: options.tokenUsage.cacheRead ?? 0,
        cacheWrite: options.tokenUsage.cacheWrite ?? 0,
        ...(options.tokenUsage.reasoningTokens !== undefined
          ? { reasoningTokens: options.tokenUsage.reasoningTokens }
          : {}),
        ...(options.tokenUsage.contextUsage
          ? { contextUsage: options.tokenUsage.contextUsage }
          : {}),
        totalTokens:
          options.tokenUsage.total ??
          (options.tokenUsage.input ?? 0) +
            (options.tokenUsage.output ?? 0) +
            (options.tokenUsage.cacheRead ?? 0) +
            (options.tokenUsage.cacheWrite ?? 0),
        cost: ZERO_USAGE.cost,
      }
    : ZERO_USAGE;
  const refusal = options.providerRefusal;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: attribution.modelId,
    usage,
    stopReason: options.aborted ? "aborted" : options.promptError || refusal ? "error" : "stop",
    errorMessage:
      refusal?.message ??
      (options.promptError ? formatErrorMessage(options.promptError) : undefined),
    ...(refusal
      ? {
          diagnostics: [
            {
              type: "provider_refusal",
              timestamp: Date.now(),
              details: { provider: "openai", category: refusal.category },
            },
          ],
        }
      : {}),
    timestamp: Date.now(),
  };
}

export function createAssistantCommentaryMessage(
  params: CodexAssistantMessageParams,
  text: string,
  itemId: string,
  timestamp: number,
): AssistantMessage {
  const message: AssistantMessage & {
    openclawStreamFallback: { replacementText: string; source: "segment"; itemId: string };
  } = {
    ...createNonterminalAssistantMessage(params, [{ type: "text", text }], timestamp),
    // Keep this unphased: gateway history hides commentary-phase assistant rows.
    // The keyed fallback persists Control UI narration without channel delivery.
    openclawStreamFallback: {
      replacementText: text,
      source: "segment",
      itemId,
    },
  };
  return message;
}

export function createAssistantAsyncMessage(
  params: CodexAssistantMessageParams,
  text: string,
  itemId: string,
  timestamp: number,
): CodexAsyncAssistantMessage {
  return {
    ...createNonterminalAssistantMessage(params, [{ type: "text", text }], timestamp),
    openclawAsyncDelivery: { itemId },
  };
}

export function createAssistantReasoningMessage(
  params: CodexAssistantMessageParams,
  text: string,
): AssistantMessage {
  // Shared history and visibility controls need reasoning, not final-answer text.
  return createNonterminalAssistantMessage(params, [{ type: "thinking", thinking: text }]);
}

function createNonterminalAssistantMessage(
  params: CodexAssistantMessageParams,
  content: AssistantMessage["content"],
  timestamp?: number,
): AssistantMessage {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return {
    role: "assistant",
    content,
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: params.modelId,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: timestamp ?? Date.now(),
  };
}
