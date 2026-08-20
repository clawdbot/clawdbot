import {
  type FailoverClassificationCorpusRow,
  billingSource,
  contextOverflow,
  errorsSource,
  messageRows,
  patternsSource,
  structuredSource,
} from "./failover-classification.corpus.test-support.js";
export const overflowCases = [
  // Context overflow.
  {
    id: "billing-context-request-too-large",
    source: billingSource,
    signal: { message: "request_too_large" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-maximum-size",
    source: billingSource,
    signal: { message: "Request exceeds the maximum size" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-length-exceeded",
    source: billingSource,
    signal: { message: "context length exceeded" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-maximum-length",
    source: billingSource,
    signal: { message: "Maximum context length" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-prompt-token-count",
    source: billingSource,
    signal: { message: "prompt is too long: 208423 tokens > 200000 maximum" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-compaction-failed",
    source: billingSource,
    signal: { message: "Context overflow: Summarization failed" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-413",
    source: billingSource,
    signal: { message: "413 Request Entity Too Large" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-anthropic-json",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
    },
    expected: contextOverflow,
  },
  {
    id: "billing-context-anthropic-400-json",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
    },
    expected: contextOverflow,
  },
  {
    id: "billing-context-kimi-limit",
    source: billingSource,
    signal: {
      message:
        "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
    },
    expected: contextOverflow,
  },
  {
    id: "billing-context-kimi-status",
    source: billingSource,
    signal: {
      message:
        "error, status code: 400, message: Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
    },
    expected: contextOverflow,
  },
  {
    id: "billing-context-max-tokens-sum",
    source: billingSource,
    signal: {
      message: "input length and max_tokens exceed context limit (i.e 156321 + 48384 > 200000)",
    },
    expected: contextOverflow,
  },
  {
    id: "billing-context-model-maximum",
    source: billingSource,
    signal: { message: "This request exceeds the model's maximum context length" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-max-tokens-window",
    source: billingSource,
    signal: { message: "LLM request rejected: max_tokens would exceed context window" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-input-budget",
    source: billingSource,
    signal: { message: "input length would exceed context budget for this model" },
    expected: contextOverflow,
  },
  {
    // FIXED(refactor-06): PR 2 removed the embedded-429 false positive; the provider wording is overflow.
    id: "billing-context-input-length-model-limit",
    source: billingSource,
    signal: { message: "input length 14295 tokens exceeds the model limit" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-stop-reason",
    source: billingSource,
    signal: { message: "Unhandled stop reason: model_context_window_exceeded" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-chinese-too-long",
    source: billingSource,
    signal: { message: "错误：上下文过长，请减少输入" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-chinese-compress",
    source: billingSource,
    signal: { message: "请压缩上下文后重试" },
    expected: contextOverflow,
  },
  {
    id: "billing-context-404-vertex",
    source: billingSource,
    signal: { message: "HTTP 404: INVALID_ARGUMENT: input exceeds the maximum number of tokens" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-bedrock-validation",
    source: patternsSource,
    signal: { message: "ValidationException: The input is too long for the model" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-bedrock-token-count",
    source: patternsSource,
    signal: {
      message: "ValidationException: Input token count exceeds the maximum number of input tokens",
    },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-bedrock-stream",
    source: patternsSource,
    signal: { message: "ModelStreamErrorException: Input is too long for this model" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-vertex",
    source: patternsSource,
    signal: { message: "INVALID_ARGUMENT: input exceeds the maximum number of tokens" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-ollama",
    source: patternsSource,
    signal: { message: "ollama error: context length exceeded, too many tokens" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-mistral",
    source: patternsSource,
    signal: { message: "mistral: input is too long for this model" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-cohere",
    source: patternsSource,
    signal: { message: "total tokens exceeds the model's maximum limit of 4096" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-llamacpp-available",
    source: patternsSource,
    signal: {
      message:
        "400 request (66202 tokens) exceeds the available context size (65536 tokens), try increasing it",
    },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-llamacpp-no-the",
    source: patternsSource,
    signal: { message: "request (130000 tokens) exceeds available context size (131072 tokens)" },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-llamacpp-prompt",
    source: patternsSource,
    signal: {
      message:
        "prompt (8500 tokens) exceeds the available context size (8192 tokens), try increasing it",
    },
    expected: contextOverflow,
  },
  {
    id: "patterns-context-ds4",
    source: patternsSource,
    signal: {
      message: "400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
    },
    expected: contextOverflow,
  },
  {
    id: "structured-context-raw-invalid-request",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
    },
    expected: contextOverflow,
  },
  {
    id: "structured-context-typed-invalid-request",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      errorType: "invalid_request_error",
      message: "Request size exceeds model context window",
    },
    expected: contextOverflow,
  },
  {
    id: "errors-context-codex-prompt-window",
    source: errorsSource,
    signal: {
      message:
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
    },
    expected: contextOverflow,
  },
  ...messageRows(billingSource, contextOverflow, [
    {
      id: "billing-context-model-token-limit-short",
      message: "Your request exceeded model token limit",
    },
    {
      id: "billing-context-window-limit",
      message: "The request size exceeds model context window limit",
    },
    { id: "billing-context-window-code", message: "context_window_exceeded" },
    { id: "billing-context-chinese-exceeds", message: "上下文超出限制" },
    { id: "billing-context-chinese-model-max", message: "上下文长度超出模型最大限制" },
    { id: "billing-context-chinese-maximum", message: "超出最大上下文长度" },
    {
      id: "billing-context-compaction-json",
      message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
    },
    { id: "billing-context-compaction-prompt", message: "Compaction failed: prompt is too long" },
  ]),
  ...messageRows(patternsSource, contextOverflow, [
    { id: "patterns-context-generic-input", message: "input is too long for model gpt-5.4" },
    { id: "patterns-context-ollama-short", message: "ollama error: context length exceeded" },
    {
      id: "patterns-context-prompt-token-limit",
      message: "prompt is too long: 150000 tokens > 128000 maximum",
    },
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
