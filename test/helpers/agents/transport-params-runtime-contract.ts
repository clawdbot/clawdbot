// Shared transport parameter contract fixtures for GPT-5 model tests.

/** Expected OpenAI GPT-5 transport defaults. */
export const OPENAI_GPT5_TRANSPORT_DEFAULTS = {
  parallel_tool_calls: true,
  text_verbosity: "low",
} as const;

/** OpenAI GPT-5 cases that should receive GPT transport defaults. */
export const OPENAI_GPT5_TRANSPORT_DEFAULT_CASES = [
  {
    provider: "openai",
    modelId: "gpt-5.4",
  },
  {
    provider: "openai",
    modelId: "gpt-5.4",
  },
] as const;

/** Non-OpenAI GPT-5 case that should not receive OpenAI defaults. */
export const NON_OPENAI_GPT5_TRANSPORT_CASE = {
  provider: "openrouter",
  modelId: "gpt-5.4",
} as const;

/** Payload APIs that support parallel_tool_calls in GPT tests. */
export const GPT_PARALLEL_TOOL_CALLS_PAYLOAD_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "azure-openai-responses",
] as const;

/** Payload APIs unrelated to GPT parallel tool call defaults. */
export const UNRELATED_TOOL_CALLS_PAYLOAD_APIS = [
  "anthropic-messages",
  "google-generative-ai",
] as const;
