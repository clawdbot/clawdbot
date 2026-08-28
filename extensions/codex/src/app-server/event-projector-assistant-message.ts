import {
  formatErrorMessage,
  type NormalizedUsage,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage, Usage } from "openclaw/plugin-sdk/llm";
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
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: attribution.modelId,
    usage,
    stopReason: options.aborted ? "aborted" : options.promptError ? "error" : "stop",
    errorMessage: options.promptError ? formatErrorMessage(options.promptError) : undefined,
    timestamp: Date.now(),
  };
}

export function createAssistantCommentaryMessage(
  params: CodexAssistantMessageParams,
  text: string,
  itemId: string,
  timestamp: number,
): AssistantMessage {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  const message: AssistantMessage & {
    openclawStreamFallback: { replacementText: string; source: "segment"; itemId: string };
  } = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: params.modelId,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp,
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
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: params.modelId,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp,
    openclawAsyncDelivery: { itemId },
  };
}

export function createAssistantMirrorMessage(
  params: CodexAssistantMessageParams,
  title: string,
  text: string,
): AssistantMessage {
  const attribution = resolveCodexLocalRuntimeAttribution(params);
  return {
    role: "assistant",
    content: [{ type: "text", text: `${title}:\n${text}` }],
    api: attribution.api ?? "openai-chatgpt-responses",
    provider: attribution.provider,
    model: params.modelId,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
