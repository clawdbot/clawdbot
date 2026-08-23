import {
  type FailoverClassificationCorpusRow,
  billingSource,
  errorsSource,
  httpSource,
  matchesSource,
  messageRows,
  failoverSignalRows,
  openRouterSource,
  patternsSource,
  reason,
  retrySource,
} from "./failover-classification.corpus.test-support.js";
export const overflowServerMiscCases = [
  // Transient transport and provider failures.
  ...failoverSignalRows(billingSource, reason("timeout"), [
    ["billing-deadline-exceeded", { message: "deadline exceeded" }],
    ["billing-no-stream-chunks", { message: "request ended without sending any chunks" }],
    ["billing-connection-error", { message: "Connection error." }],
    ["billing-fetch-failed", { message: "fetch failed" }],
    ["billing-econnrefused", { message: "network error: ECONNREFUSED" }],
    [
      "billing-enotfound",
      { message: "dial tcp: lookup api.example.com: no such host (ENOTFOUND)" },
    ],
    ["billing-dns-eai-again", { message: "temporary dns failure EAI_AGAIN" }],
    [
      "billing-cloudflare-521",
      {
        message:
          "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
      },
    ],
    [
      "billing-openai-retry-guidance",
      {
        provider: "openai",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID synthetic-provider-request-001 in your message.",
      },
    ],
    // #71620
    ["billing-shared-runtime-unknown-error", { message: "An unknown error occurred" }],
    ["billing-generic-410", { message: "HTTP 410 Gone" }],
    // #42149
    [
      "billing-gemini-malformed-response",
      { provider: "google", message: "Unhandled stop reason: MALFORMED_RESPONSE" },
    ],
    // #58315
    ["billing-operation-aborted", { message: "The operation was aborted" }],
    ["billing-stream-aborted", { message: "stream was aborted" }],
    ["billing-etimedout", { message: "Error: connect ETIMEDOUT 10.0.0.1:443" }],
    ["billing-ehostunreach", { message: "Error: connect EHOSTUNREACH 10.0.0.1:443" }],
    ["billing-epipe", { message: "Error: write EPIPE" }],
    // #61281
    [
      "billing-provider-network-finish-reason",
      { message: "Provider finish_reason: network_error" },
    ],
    // #69368
    ["billing-undici-socket", { message: "Error: UND_ERR_SOCKET other side closed" }],
    ["billing-undici-connect-timeout", { message: "UND_ERR_CONNECT_TIMEOUT" }],
    [
      "billing-request-failed-retries",
      { message: "Request failed after repeated internal retries." },
    ],
    [
      "billing-google-internal-500",
      {
        provider: "google",
        message:
          "provider=google model=gemini-3.1-flash-lite-preview got status: INTERNAL upstream failure code:500",
      },
    ],
    [
      "billing-mini-max-520",
      { message: '{"type":"api_error","message":"unknown error, 520 (1000)"}' },
    ],
    // #57010
    [
      "billing-anthropic-unexpected-error",
      {
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"api_error","message":"An unexpected error occurred while processing the response"}}',
      },
    ],
    // #56242
    [
      "billing-zhipu-network-1234",
      {
        provider: "zai",
        message:
          "LLM error 1234: 网络错误，错误id：202603281427587491f4467f1c4712，请联系客服。 (request_id: 202603281427587491f4467f1c4712)",
      },
    ],
    ["billing-chinese-network-abnormal", { message: "网络异常，请稍后重试" }],
    ["billing-chinese-service-busy", { message: "服务繁忙，请稍后再试" }],
    ["billing-chinese-system-error", { message: "系统错误，请稍后重试" }],
  ]),
  ...failoverSignalRows(patternsSource, reason("timeout"), [
    [
      "patterns-cloudflare-html-502",
      {
        status: 502,
        message:
          "<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>cloudflare-nginx</p></body></html>",
      },
    ],
    [
      "patterns-cloudflare-html-503",
      {
        status: 503,
        message:
          "<!doctype html><html><head><title>503</title></head><body><h1>Service Unavailable</h1><p>Please try again. Rate limit exceeded.</p></body></html>",
      },
    ],
  ]),
  {
    id: "retry-explicit-retry-guidance",
    source: retrySource,
    signal: {
      message: "An error occurred while processing your request. You can retry your request.",
    },
    expected: reason("timeout"),
  },
  {
    id: "retry-openai-500",
    source: retrySource,
    signal: {
      provider: "openai",
      message:
        "OpenAI API error (500): 500 The server had an error while processing your request. Sorry about that!",
    },
    expected: null,
  },
  {
    id: "retry-azure-502",
    source: retrySource,
    signal: {
      provider: "azure-openai",
      message: "Azure OpenAI API error (502): Bad gateway from upstream",
    },
    expected: reason("timeout"),
  },
  {
    id: "retry-mistral-503",
    source: retrySource,
    signal: {
      provider: "mistral",
      message: "Mistral API error (503): service temporarily unavailable",
    },
    // FIXED(refactor-02): was timeout, now overloaded
    expected: reason("overloaded"),
  },
  {
    id: "retry-provider-504",
    source: retrySource,
    signal: { message: "Provider API error (504): gateway timeout" },
    expected: reason("timeout"),
  },
  {
    id: "http-provider-503",
    source: httpSource,
    signal: { status: 503, message: "Provider API error (503)" },
    expected: reason("timeout"),
  },
  {
    id: "openrouter-network-finish",
    source: openRouterSource,
    signal: { provider: "openrouter", message: "Provider finish_reason: network_error" },
    expected: reason("timeout"),
  },
  {
    id: "errors-malformed-streaming-fragment",
    source: errorsSource,
    signal: { message: "OpenClaw transport error: malformed_streaming_fragment" },
    expected: null,
  },
  {
    id: "http-provider-timeout",
    source: httpSource,
    signal: { message: "provider body timed out 50" },
    expected: reason("timeout"),
  },
  ...messageRows(billingSource, reason("overloaded"), [
    // FIXED(refactor-02): was timeout, now overloaded
    { id: "billing-status-503", message: "503 Service Unavailable" },
    // FIXED(refactor-02): was timeout, now overloaded
    { id: "billing-llm-service-unavailable", message: "LLM error: service unavailable" },
    // FIXED(refactor-02): was timeout, now overloaded
    {
      id: "billing-api-error-unavailable",
      message:
        '{"type":"error","error":{"type":"api_error","message":"Service temporarily unavailable"}}',
    },
  ]),
  ...messageRows(billingSource, reason("timeout"), [
    { id: "billing-status-499", message: "499 Client Closed Request" },
    { id: "billing-status-500", message: "500 Internal Server Error" },
    { id: "billing-status-502", message: "502 Bad Gateway" },
    { id: "billing-status-504", message: "504 Gateway Timeout" },
    { id: "billing-503-database", message: "503 Internal Database Error" },
    { id: "billing-stop-abort", message: "Unhandled stop reason: abort" },
    { id: "billing-stream-closed", message: "stream was closed" },
    { id: "billing-esockettimedout", message: "Error: connect ESOCKETTIMEDOUT 10.0.0.1:443" },
    { id: "billing-enetunreach", message: "Error: connect ENETUNREACH 10.0.0.1:443" },
    { id: "billing-enetreset", message: "Error: read ENETRESET" },
    { id: "billing-ehostdown", message: "Error: connect EHOSTDOWN 192.168.1.1:443" },
    {
      id: "billing-zai-network-stop",
      message: "Unhandled stop reason: network_error",
      provider: "zai",
    },
    { id: "billing-provider-abort", message: "Provider finish_reason: abort" },
    { id: "billing-provider-malformed", message: "Provider finish_reason: malformed_response" },
    { id: "billing-undici-terminated", message: "terminated" },
    { id: "billing-stream-read-error", message: "stream_read_error" },
    { id: "billing-undici-headers-timeout", message: "UND_ERR_HEADERS_TIMEOUT" },
    { id: "billing-undici-body-timeout", message: "UND_ERR_BODY_TIMEOUT" },
    { id: "billing-undici-aborted", message: "UND_ERR_ABORTED" },
    { id: "billing-undici-content-length", message: "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH" },
    { id: "billing-request-failed", message: "Request failed" },
    {
      id: "billing-api-error-internal",
      message: '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
    },
    {
      id: "billing-zhipu-network-json",
      message:
        '{"error":{"code":"1234","message":"网络错误，错误id：abc123，请联系客服。"},"request_id":"abc123"}',
      provider: "zai",
    },
    { id: "billing-chinese-connect-timeout", message: "连接超时" },
    { id: "billing-chinese-request-timeout", message: "请求超时，请重试" },
    { id: "billing-chinese-service-unavailable", message: "服务暂时不可用" },
    { id: "billing-chinese-connection-error", message: "连接错误" },
    { id: "billing-chinese-internal", message: "内部错误" },
    { id: "billing-chinese-server", message: "服务器错误" },
    { id: "billing-chinese-server-internal", message: "服务器内部错误" },
    { id: "billing-chinese-system-busy", message: "系统繁忙" },
    { id: "billing-chinese-system-abnormal", message: "系统异常" },
  ]),
  ...messageRows(retrySource, reason("overloaded"), [
    // FIXED(refactor-02): was timeout, now overloaded
    {
      id: "retry-billing-service",
      message: "503 billing service unavailable; please retry your request",
    },
    // FIXED(refactor-02): was timeout, now overloaded
    {
      id: "retry-subscription-service",
      message: "503 subscription service unavailable while checking quota",
    },
    // FIXED(refactor-02): was timeout, now overloaded
    { id: "retry-503-retry-after", message: "503 Service Unavailable; Retry-After: 120 seconds" },
  ]),
  ...messageRows(retrySource, reason("timeout"), [
    { id: "retry-http-500", message: "HTTP 500 temporary provider response" },
    { id: "retry-503", message: "503: temporary provider response" },
    { id: "retry-524", message: "524 status code (no body)" },
  ]),
  ...messageRows(patternsSource, reason("auth"), [
    {
      id: "patterns-cloudflare-challenge",
      status: 403,
      message:
        "<!doctype html><html><head><title>403 Forbidden</title></head><body>Enable JavaScript and cookies to continue.<p>Please stand by, while we are checking your browser...</p></body></html>",
    },
    {
      id: "patterns-cloudflare-cdn-cgi",
      status: 403,
      message:
        '<!doctype html><html><head><title>403 Forbidden</title></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page"></script><p>Checking your browser...</p></body></html>',
    },
  ]),
  // Provider-completed server errors.
  ...failoverSignalRows(billingSource, reason("server_error"), [
    [
      "billing-openai-structured-server-error",
      {
        provider: "openai",
        message:
          'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
      },
    ],
    // #109218
    ["billing-provider-finish-error", { message: "Provider finish_reason: error" }],
  ]),
  {
    id: "matches-provider-finish-error",
    source: matchesSource,
    signal: { message: "Provider finish_reason: error" },
    expected: reason("server_error"),
  },
  {
    id: "openrouter-finish-error",
    source: openRouterSource,
    signal: { provider: "openrouter", message: "Provider finish_reason: error" },
    expected: reason("server_error"),
  },
  {
    id: "ollama-incomplete-stream",
    source: "extensions/ollama/index.test.ts",
    signal: { provider: "ollama", message: "Ollama API stream ended without a final response" },
    expected: null,
  },
  // Missing models and expired sessions.
  {
    id: "patterns-groq-deactivated",
    source: patternsSource,
    signal: { provider: "groq", message: "model_is_deactivated: this model has been deactivated" },
    expected: reason("model_not_found"),
  },
  {
    id: "openrouter-missing-model",
    source: openRouterSource,
    signal: {
      provider: "openrouter",
      status: 404,
      message: "No endpoints found for missing/model.",
    },
    expected: reason("model_not_found"),
  },
  ...failoverSignalRows(retrySource, reason("model_not_found"), [
    [
      "retry-mistral-model-not-found",
      { provider: "mistral", message: "Mistral API error (404): model not found" },
    ],
    // FIXED(refactor-02): was rate_limit, now model_not_found
    ["retry-gpt-preview-not-found", { message: "model gpt-5.5-preview-0429 not found" }],
    // FIXED(refactor-02): was null, now model_not_found
    ["retry-model-preview-not-found", { message: "model model-x-500-preview not found" }],
  ]),
  ...failoverSignalRows(billingSource, reason("session_expired"), [
    ["billing-session-not-found", { message: "HTTP 410: session not found" }],
    [
      "billing-claude-conversation-missing",
      { provider: "claude-cli", message: "No conversation found with session ID: abc123" },
    ],
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
