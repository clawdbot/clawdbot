import {
  createGoogleThinkingPayloadWrapper,
  createKilocodeWrapper,
  createMoonshotThinkingWrapper,
  createOpenAIDefaultTransportWrapper,
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  createToolStreamWrapper,
  getOpenRouterModelCapabilities,
  isProxyReasoningUnsupported,
  loadOpenRouterModelCapabilities,
  resolveMoonshotThinkingType,
} from "./provider-stream.js";

export {
  createOpenRouterSystemCacheWrapper,
  createOpenRouterWrapper,
  getOpenRouterModelCapabilities,
  isProxyReasoningUnsupported,
  loadOpenRouterModelCapabilities,
};

export const OPENAI_RESPONSES_STREAM_HOOKS = {
  wrapStreamFn: ({ streamFn }: { streamFn?: unknown }) =>
    createOpenAIDefaultTransportWrapper(streamFn as Parameters<typeof createOpenAIDefaultTransportWrapper>[0]),
};

export const GOOGLE_THINKING_STREAM_HOOKS = {
  wrapStreamFn: ({
    streamFn,
    thinkingLevel,
  }: {
    streamFn?: unknown;
    thinkingLevel?: unknown;
  }) =>
    createGoogleThinkingPayloadWrapper(
      streamFn as Parameters<typeof createGoogleThinkingPayloadWrapper>[0],
      thinkingLevel as Parameters<typeof createGoogleThinkingPayloadWrapper>[1],
    ),
};

export const KILOCODE_THINKING_STREAM_HOOKS = {
  wrapStreamFn: ({
    streamFn,
    thinkingLevel,
  }: {
    streamFn?: unknown;
    thinkingLevel?: unknown;
  }) =>
    createKilocodeWrapper(
      streamFn as Parameters<typeof createKilocodeWrapper>[0],
      thinkingLevel as Parameters<typeof createKilocodeWrapper>[1],
    ),
};

export const OPENROUTER_THINKING_STREAM_HOOKS = {
  wrapStreamFn: ({
    streamFn,
    thinkingLevel,
  }: {
    streamFn?: unknown;
    thinkingLevel?: unknown;
  }) =>
    createOpenRouterSystemCacheWrapper(
      createOpenRouterWrapper(
        streamFn as Parameters<typeof createOpenRouterWrapper>[0],
        thinkingLevel as Parameters<typeof createOpenRouterWrapper>[1],
      ),
    ),
};

export const TOOL_STREAM_DEFAULT_ON_HOOKS = {
  wrapStreamFn: ({ streamFn }: { streamFn?: unknown }) =>
    createToolStreamWrapper(streamFn as Parameters<typeof createToolStreamWrapper>[0], true),
};

export const MOONSHOT_THINKING_STREAM_HOOKS = {
  wrapStreamFn: ({
    streamFn,
    thinkingLevel,
    extraParams,
  }: {
    streamFn?: unknown;
    thinkingLevel?: unknown;
    extraParams?: Record<string, unknown>;
  }) =>
    createMoonshotThinkingWrapper(
      streamFn as Parameters<typeof createMoonshotThinkingWrapper>[0],
      resolveMoonshotThinkingType({
        configuredThinking: extraParams?.thinking,
        thinkingLevel: thinkingLevel as Parameters<typeof resolveMoonshotThinkingType>[0]["thinkingLevel"],
      }),
    ),
};

export function buildProviderStreamFamilyHooks(params: {
  family: "openai-responses" | "google-thinking" | "kilocode-thinking" | "openrouter-thinking";
}) {
  switch (params.family) {
    case "google-thinking":
      return GOOGLE_THINKING_STREAM_HOOKS;
    case "kilocode-thinking":
      return KILOCODE_THINKING_STREAM_HOOKS;
    case "openrouter-thinking":
      return OPENROUTER_THINKING_STREAM_HOOKS;
    case "openai-responses":
    default:
      return OPENAI_RESPONSES_STREAM_HOOKS;
  }
}
