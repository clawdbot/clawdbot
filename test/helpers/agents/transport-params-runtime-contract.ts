export const OPENAI_GPT5_TRANSPORT_DEFAULTS = {
  parallel_tool_calls: true,
  text_verbosity: "low",
} as const;

export const OPENAI_GPT5_TRANSPORT_DEFAULT_CASES = [
  {
    provider: "openai",
    modelId: "gpt-5.4",
  },
  {
    provider: "openai-codex",
    modelId: "gpt-5.4",
  },
] as const;

export const NON_OPENAI_GPT5_TRANSPORT_CASE = {
  provider: "openrouter",
  modelId: "gpt-5.4",
} as const;

export const GPT_PARALLEL_TOOL_CALLS_PAYLOAD_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
] as const;

export const UNRELATED_TOOL_CALLS_PAYLOAD_APIS = [
  "anthropic-messages",
  "google-generative-ai",
] as const;
