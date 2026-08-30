import {
  type FailoverClassificationCorpusRow,
  billingSource,
  errorsSource,
  httpSource,
  matchesSource,
  messageRows,
  failoverSignalRows,
  patternsSource,
  reason,
  retrySource,
  structuredSource,
} from "./failover-classification.corpus.test-support.js";
export const structuredMiscCases = [
  // Explicitly unclassified current behavior.
  {
    id: "billing-image-dimension",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels"}}',
    },
    expected: reason("format"),
  },
  ...failoverSignalRows(billingSource, null, [
    ["billing-image-size", { message: "image exceeds 5 MB maximum" }],
    [
      "billing-malformed-function-call",
      { message: "Unhandled stop reason: MALFORMED_FUNCTION_CALL" },
    ],
    ["billing-bare-400", { message: "400 status code (no body)" }],
  ]),
  {
    id: "matches-google-invalid-argument",
    source: matchesSource,
    signal: {
      provider: "google",
      message:
        "Google Generative AI API error (400): Request contains an invalid argument. [code=INVALID_ARGUMENT]",
    },
    expected: null,
  },
  {
    id: "patterns-bedrock-generic-model-not-ready",
    source: patternsSource,
    signal: { message: "model is not ready" },
    expected: null,
  },
  ...failoverSignalRows(structuredSource, null, [
    [
      "structured-rate-limit-type-without-hook",
      { provider: "anthropic", errorType: "rate_limit_error", message: "" },
    ],
    [
      "structured-api-error-type-without-hook",
      { provider: "anthropic", errorType: "api_error", message: "" },
    ],
    ["structured-non-owner-server-code", { provider: "google", code: "SERVER_ERROR", message: "" }],
    [
      "structured-non-owner-insufficient-quota",
      { provider: "anthropic", code: "INSUFFICIENT_QUOTA", message: "" },
    ],
  ]),
  {
    id: "http-bad-request",
    source: httpSource,
    signal: { status: 400, code: "invalid_request", message: "Bad request" },
    expected: reason("format"),
  },
  {
    id: "retry-openai-model-id-400",
    source: retrySource,
    signal: {
      provider: "openai",
      message: "OpenAI API error (400): 400 Model Id [gpt-5.4-nano] not found",
    },
    // FIXED(refactor-02): was null, now model_not_found
    expected: reason("model_not_found"),
  },
  {
    id: "ollama-malformed-tool-arguments",
    source: "extensions/ollama/index.test.ts",
    signal: { provider: "ollama", message: "Ollama returned malformed tool arguments" },
    expected: null,
  },
  {
    id: "xai-forbidden-generic",
    source: "extensions/xai/index.test.ts",
    signal: { provider: "xai", message: "403 Forbidden" },
    expected: reason("auth"),
  },
  ...messageRows(billingSource, null, [
    {
      id: "billing-context-compaction-auto",
      message: "auto-compaction failed due to context overflow",
    },
    {
      id: "billing-context-compaction-window",
      message: "Summarization failed: context window exceeded for this request",
    },
    {
      id: "billing-context-model-window-request",
      message: "Model context window is 128k tokens, you requested 256k tokens",
    },
    {
      id: "billing-context-window-requested",
      message: "Context window exceeded: requested 12000 tokens",
    },
    { id: "billing-context-prompt-large", message: "Prompt too large for this model" },
  ]),
  ...messageRows(retrySource, null, [
    {
      id: "retry-system-unexpected",
      message: "The system encountered an unexpected error. Try your request again.",
    },
    {
      id: "retry-temporary-provider",
      message: "Temporary provider failure; please retry your request.",
    },
    {
      id: "retry-socket-closed",
      message: "The socket connection was closed unexpectedly by fetch",
    },
    { id: "retry-connection-refused", message: "connection refused" },
    { id: "retry-connection-lost", message: "connection lost" },
    { id: "retry-other-side-closed", message: "other side closed" },
    { id: "retry-reset-before-headers", message: "upstream reset before headers" },
    { id: "retry-websocket-closed", message: "WebSocket closed unexpectedly" },
    { id: "retry-websocket-error", message: "WebSocket error" },
    { id: "retry-http2-no-response", message: "HTTP2 request did not get a response" },
    { id: "retry-delay", message: "retry delay 1000ms" },
    {
      id: "retry-ended-without-terminal-response",
      message: "provider request ended without a terminal response",
    },
    { id: "retry-rate-limit-hyphen", message: "rate-limit reached" },
  ]),
  ...messageRows(errorsSource, null, [
    {
      id: "errors-json-parse-position",
      message:
        "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)",
    },
  ]),
  ...messageRows(httpSource, null, [
    {
      id: "http-provider-catalog-malformed",
      message: "Provider catalog failed: malformed JSON response",
    },
    {
      id: "http-provider-json-malformed",
      message: "Provider JSON failed: malformed JSON response",
    },
  ]),
  ...messageRows(retrySource, null, [
    {
      id: "retry-image-dimensions",
      message: "Image dimensions 1504x1504 exceed the maximum allowed size",
    },
    { id: "retry-image-width", message: "Image width 500 exceeds the maximum allowed size" },
  ]),
  ...failoverSignalRows(structuredSource, null, [
    ["structured-openai-internal-non-owner", { provider: "openai", code: "INTERNAL", message: "" }],
    [
      "structured-openai-deadline-non-owner",
      { provider: "openai", code: "DEADLINE_EXCEEDED", message: "" },
    ],
    [
      "structured-anthropic-unavailable-non-owner",
      { provider: "anthropic", code: "UNAVAILABLE", message: "" },
    ],
    [
      "structured-google-api-error-non-owner",
      { provider: "google", code: "API_ERROR", message: "" },
    ],
    [
      "structured-google-rate-limit-error-non-owner",
      { provider: "google", code: "RATE_LIMIT_ERROR", message: "" },
    ],
    [
      "structured-generic-sdk-type",
      { provider: "demo-provider", message: "unclassified provider failure" },
    ],
  ]),
  // Structured provider codes with hooks intentionally disabled for determinism.
  ...failoverSignalRows("extensions/anthropic/index.test.ts", null, [
    [
      "anthropic-rate-limit-error-type-core-fallback",
      { provider: "anthropic", errorType: "rate_limit_error", message: "" },
    ],
    [
      "anthropic-api-error-type-core-fallback",
      { provider: "anthropic", errorType: "api_error", message: "" },
    ],
    [
      "anthropic-rate-limit-code-core-fallback",
      { provider: "anthropic", code: "RATE_LIMIT_ERROR", message: "" },
    ],
    [
      "anthropic-api-error-code-core-fallback",
      { provider: "anthropic", code: "API_ERROR", message: "" },
    ],
  ]),
  ...failoverSignalRows("extensions/openai/openai-provider.test.ts", null, [
    ["openai-server-code-core-fallback", { provider: "openai", code: "SERVER_ERROR", message: "" }],
    [
      "openai-insufficient-quota-code-core-fallback",
      { provider: "openai", code: "INSUFFICIENT_QUOTA", message: "" },
    ],
  ]),
  ...failoverSignalRows("extensions/google/provider-hooks.test.ts", null, [
    [
      "google-unavailable-code-core-fallback",
      { provider: "google", code: "UNAVAILABLE", message: "" },
    ],
    [
      "google-deadline-code-core-fallback",
      { provider: "google-vertex", code: "DEADLINE_EXCEEDED", message: "" },
    ],
    [
      "google-internal-code-core-fallback",
      { provider: "google-antigravity", code: "INTERNAL", message: "" },
    ],
  ]),
  ...failoverSignalRows("extensions/anthropic/index.test.ts", null, [
    [
      "anthropic-claude-cli-rate-limit-type-core-fallback",
      { provider: "claude-cli", errorType: "rate_limit_error", message: "" },
    ],
    [
      "anthropic-claude-cli-api-error-type-core-fallback",
      { provider: "claude-cli", errorType: "api_error", message: "" },
    ],
    [
      "anthropic-rate-limit-type-api-code-core-fallback",
      {
        provider: "anthropic",
        errorType: "rate_limit_error",
        code: "API_ERROR",
        message: "",
      },
    ],
    [
      "anthropic-insufficient-quota-code-core-fallback",
      {
        provider: "anthropic",
        errorType: "UNKNOWN_ERROR",
        code: "INSUFFICIENT_QUOTA",
        message: "",
      },
    ],
  ]),
  ...failoverSignalRows("extensions/openai/openai-provider.test.ts", null, [
    [
      "azure-openai-server-code-core-fallback",
      { provider: "azure-openai", code: "SERVER_ERROR", message: "" },
    ],
    [
      "azure-openai-insufficient-quota-code-core-fallback",
      { provider: "azure-openai", code: "INSUFFICIENT_QUOTA", message: "" },
    ],
    [
      "azure-openai-responses-server-code-core-fallback",
      { provider: "azure-openai-responses", code: "SERVER_ERROR", message: "" },
    ],
    [
      "azure-openai-responses-insufficient-quota-code-core-fallback",
      { provider: "azure-openai-responses", code: "INSUFFICIENT_QUOTA", message: "" },
    ],
    ["openai-api-error-code-core-fallback", { provider: "openai", code: "API_ERROR", message: "" }],
  ]),
  ...failoverSignalRows("extensions/google/provider-hooks.test.ts", null, [
    [
      "google-gemini-cli-unavailable-core-fallback",
      { provider: "google-gemini-cli", code: "UNAVAILABLE", message: "" },
    ],
    [
      "google-insufficient-quota-core-fallback",
      { provider: "google-vertex", code: "INSUFFICIENT_QUOTA", message: "" },
    ],
  ]),
  {
    id: "ollama-cloud-incomplete-stream",
    source: "extensions/ollama/index.test.ts",
    signal: {
      provider: "ollama-cloud",
      message: "Ollama API stream ended without a final response",
    },
    expected: null,
  },
] satisfies readonly FailoverClassificationCorpusRow[];
