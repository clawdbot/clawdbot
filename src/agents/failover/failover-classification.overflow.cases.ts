import {
  type FailoverClassificationCorpusRow,
  billingSource,
  contextOverflow,
  errorsSource,
  messageRows,
  failoverSignalRows,
  patternsSource,
  structuredSource,
} from "./failover-classification.corpus.test-support.js";
export const overflowCases = [
  // Context overflow.
  ...failoverSignalRows(billingSource, contextOverflow, [
    ["billing-context-request-too-large", { message: "request_too_large" }],
    ["billing-context-maximum-size", { message: "Request exceeds the maximum size" }],
    ["billing-context-length-exceeded", { message: "context length exceeded" }],
    ["billing-context-maximum-length", { message: "Maximum context length" }],
    [
      "billing-context-prompt-token-count",
      { message: "prompt is too long: 208423 tokens > 200000 maximum" },
    ],
    ["billing-context-compaction-failed", { message: "Context overflow: Summarization failed" }],
    ["billing-context-413", { message: "413 Request Entity Too Large" }],
    [
      "billing-context-anthropic-json",
      {
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      },
    ],
    [
      "billing-context-anthropic-400-json",
      {
        provider: "anthropic",
        message:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      },
    ],
    [
      "billing-context-kimi-limit",
      {
        message:
          "Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      },
    ],
    [
      "billing-context-kimi-status",
      {
        message:
          "error, status code: 400, message: Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
      },
    ],
    [
      "billing-context-max-tokens-sum",
      {
        message: "input length and max_tokens exceed context limit (i.e 156321 + 48384 > 200000)",
      },
    ],
    [
      "billing-context-model-maximum",
      { message: "This request exceeds the model's maximum context length" },
    ],
    [
      "billing-context-max-tokens-window",
      { message: "LLM request rejected: max_tokens would exceed context window" },
    ],
    [
      "billing-context-input-budget",
      { message: "input length would exceed context budget for this model" },
    ],
    // FIXED(refactor-06): PR 2 removed the embedded-429 false positive; the provider wording is overflow.
    [
      "billing-context-input-length-model-limit",
      { message: "input length 14295 tokens exceeds the model limit" },
    ],
    [
      "billing-context-stop-reason",
      { message: "Unhandled stop reason: model_context_window_exceeded" },
    ],
    ["billing-context-chinese-too-long", { message: "错误：上下文过长，请减少输入" }],
    ["billing-context-chinese-compress", { message: "请压缩上下文后重试" }],
    [
      "billing-context-404-vertex",
      { message: "HTTP 404: INVALID_ARGUMENT: input exceeds the maximum number of tokens" },
    ],
  ]),
  ...failoverSignalRows(patternsSource, contextOverflow, [
    [
      "patterns-context-bedrock-validation",
      { message: "ValidationException: The input is too long for the model" },
    ],
    [
      "patterns-context-bedrock-token-count",
      {
        message:
          "ValidationException: Input token count exceeds the maximum number of input tokens",
      },
    ],
    [
      "patterns-context-bedrock-stream",
      { message: "ModelStreamErrorException: Input is too long for this model" },
    ],
    [
      "patterns-context-vertex",
      { message: "INVALID_ARGUMENT: input exceeds the maximum number of tokens" },
    ],
    [
      "patterns-context-ollama",
      { message: "ollama error: context length exceeded, too many tokens" },
    ],
    ["patterns-context-mistral", { message: "mistral: input is too long for this model" }],
    [
      "patterns-context-cohere",
      { message: "total tokens exceeds the model's maximum limit of 4096" },
    ],
    ["patterns-context-llamacpp-exceeded", { message: "Context size has been exceeded." }],
    ["patterns-context-llamacpp-exceeded-400", { message: "400 Context size has been exceeded." }],
    ["patterns-context-llamacpp-exceeded-500", { message: "500 Context size has been exceeded." }],
    [
      "patterns-context-llamacpp-available",
      {
        message:
          "400 request (66202 tokens) exceeds the available context size (65536 tokens), try increasing it",
      },
    ],
    [
      "patterns-context-llamacpp-no-the",
      { message: "request (130000 tokens) exceeds available context size (131072 tokens)" },
    ],
    [
      "patterns-context-llamacpp-prompt",
      {
        message:
          "prompt (8500 tokens) exceeds the available context size (8192 tokens), try increasing it",
      },
    ],
    [
      "patterns-context-ds4",
      {
        message: "400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
      },
    ],
  ]),
  ...failoverSignalRows(structuredSource, contextOverflow, [
    [
      "structured-context-raw-invalid-request",
      {
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
      },
    ],
    [
      "structured-context-typed-invalid-request",
      {
        provider: "anthropic",
        errorType: "invalid_request_error",
        message: "Request size exceeds model context window",
      },
    ],
  ]),
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
