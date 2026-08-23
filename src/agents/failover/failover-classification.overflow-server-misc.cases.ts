import {
  type FailoverClassificationCorpusRow,
  billingSource,
  errorsSource,
  httpSource,
  matchesSource,
  messageRows,
  openRouterSource,
  patternsSource,
  reason,
  retrySource,
} from "./failover-classification.corpus.test-support.js";
export const overflowServerMiscCases = [
  // Transient transport and provider failures.
  {
    id: "billing-deadline-exceeded",
    source: billingSource,
    signal: { message: "deadline exceeded" },
    expected: reason("timeout"),
  },
  {
    id: "billing-no-stream-chunks",
    source: billingSource,
    signal: { message: "request ended without sending any chunks" },
    expected: reason("timeout"),
  },
  {
    id: "billing-connection-error",
    source: billingSource,
    signal: { message: "Connection error." },
    expected: reason("timeout"),
  },
  {
    id: "billing-fetch-failed",
    source: billingSource,
    signal: { message: "fetch failed" },
    expected: reason("timeout"),
  },
  {
    id: "billing-econnrefused",
    source: billingSource,
    signal: { message: "network error: ECONNREFUSED" },
    expected: reason("timeout"),
  },
  {
    id: "billing-enotfound",
    source: billingSource,
    signal: { message: "dial tcp: lookup api.example.com: no such host (ENOTFOUND)" },
    expected: reason("timeout"),
  },
  {
    id: "billing-dns-eai-again",
    source: billingSource,
    signal: { message: "temporary dns failure EAI_AGAIN" },
    expected: reason("timeout"),
  },
  {
    id: "billing-cloudflare-521",
    source: billingSource,
    signal: {
      message:
        "521 <!DOCTYPE html><html><head><title>Web server is down</title></head><body>Cloudflare</body></html>",
    },
    expected: reason("timeout"),
  },
  {
    id: "billing-openai-retry-guidance",
    source: billingSource,
    signal: {
      provider: "openai",
      message:
        "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID synthetic-provider-request-001 in your message.",
    },
    expected: reason("timeout"),
  },
  {
    // #71620
    id: "billing-shared-runtime-unknown-error",
    source: billingSource,
    signal: { message: "An unknown error occurred" },
    expected: reason("timeout"),
  },
  {
    id: "billing-generic-410",
    source: billingSource,
    signal: { message: "HTTP 410 Gone" },
    expected: reason("timeout"),
  },
  {
    // #42149
    id: "billing-gemini-malformed-response",
    source: billingSource,
    signal: { provider: "google", message: "Unhandled stop reason: MALFORMED_RESPONSE" },
    expected: reason("timeout"),
  },
  {
    // #58315
    id: "billing-operation-aborted",
    source: billingSource,
    signal: { message: "The operation was aborted" },
    expected: reason("timeout"),
  },
  {
    id: "billing-stream-aborted",
    source: billingSource,
    signal: { message: "stream was aborted" },
    expected: reason("timeout"),
  },
  {
    id: "billing-etimedout",
    source: billingSource,
    signal: { message: "Error: connect ETIMEDOUT 10.0.0.1:443" },
    expected: reason("timeout"),
  },
  {
    id: "billing-ehostunreach",
    source: billingSource,
    signal: { message: "Error: connect EHOSTUNREACH 10.0.0.1:443" },
    expected: reason("timeout"),
  },
  {
    id: "billing-epipe",
    source: billingSource,
    signal: { message: "Error: write EPIPE" },
    expected: reason("timeout"),
  },
  {
    // #61281
    id: "billing-provider-network-finish-reason",
    source: billingSource,
    signal: { message: "Provider finish_reason: network_error" },
    expected: reason("timeout"),
  },
  {
    // #69368
    id: "billing-undici-socket",
    source: billingSource,
    signal: { message: "Error: UND_ERR_SOCKET other side closed" },
    expected: reason("timeout"),
  },
  {
    id: "billing-undici-connect-timeout",
    source: billingSource,
    signal: { message: "UND_ERR_CONNECT_TIMEOUT" },
    expected: reason("timeout"),
  },
  {
    id: "billing-request-failed-retries",
    source: billingSource,
    signal: { message: "Request failed after repeated internal retries." },
    expected: reason("timeout"),
  },
  {
    id: "billing-google-internal-500",
    source: billingSource,
    signal: {
      provider: "google",
      message:
        "provider=google model=gemini-3.1-flash-lite-preview got status: INTERNAL upstream failure code:500",
    },
    expected: reason("timeout"),
  },
  {
    id: "billing-mini-max-520",
    source: billingSource,
    signal: { message: '{"type":"api_error","message":"unknown error, 520 (1000)"}' },
    expected: reason("timeout"),
  },
  {
    // #57010
    id: "billing-anthropic-unexpected-error",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"api_error","message":"An unexpected error occurred while processing the response"}}',
    },
    expected: reason("timeout"),
  },
  {
    // #56242
    id: "billing-zhipu-network-1234",
    source: billingSource,
    signal: {
      provider: "zai",
      message:
        "LLM error 1234: 网络错误，错误id：202603281427587491f4467f1c4712，请联系客服。 (request_id: 202603281427587491f4467f1c4712)",
    },
    expected: reason("timeout"),
  },
  {
    id: "billing-chinese-network-abnormal",
    source: billingSource,
    signal: { message: "网络异常，请稍后重试" },
    expected: reason("timeout"),
  },
  {
    id: "billing-chinese-service-busy",
    source: billingSource,
    signal: { message: "服务繁忙，请稍后再试" },
    expected: reason("timeout"),
  },
  {
    id: "billing-chinese-system-error",
    source: billingSource,
    signal: { message: "系统错误，请稍后重试" },
    expected: reason("timeout"),
  },
  {
    id: "patterns-cloudflare-html-502",
    source: patternsSource,
    signal: {
      status: 502,
      message:
        "<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>cloudflare-nginx</p></body></html>",
    },
    expected: reason("timeout"),
  },
  {
    id: "patterns-cloudflare-html-503",
    source: patternsSource,
    signal: {
      status: 503,
      message:
        "<!doctype html><html><head><title>503</title></head><body><h1>Service Unavailable</h1><p>Please try again. Rate limit exceeded.</p></body></html>",
    },
    expected: reason("timeout"),
  },
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
  {
    id: "billing-openai-structured-server-error",
    source: billingSource,
    signal: {
      provider: "openai",
      message:
        'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
    },
    expected: reason("server_error"),
  },
  {
    // #109218
    id: "billing-provider-finish-error",
    source: billingSource,
    signal: { message: "Provider finish_reason: error" },
    expected: reason("server_error"),
  },
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
  {
    id: "retry-mistral-model-not-found",
    source: retrySource,
    signal: { provider: "mistral", message: "Mistral API error (404): model not found" },
    expected: reason("model_not_found"),
  },
  {
    id: "retry-gpt-preview-not-found",
    source: retrySource,
    signal: { message: "model gpt-5.5-preview-0429 not found" },
    // FIXED(refactor-02): was rate_limit, now model_not_found
    expected: reason("model_not_found"),
  },
  {
    id: "retry-model-preview-not-found",
    source: retrySource,
    signal: { message: "model model-x-500-preview not found" },
    // FIXED(refactor-02): was null, now model_not_found
    expected: reason("model_not_found"),
  },
  {
    id: "billing-session-not-found",
    source: billingSource,
    signal: { message: "HTTP 410: session not found" },
    expected: reason("session_expired"),
  },
  {
    id: "billing-claude-conversation-missing",
    source: billingSource,
    signal: { provider: "claude-cli", message: "No conversation found with session ID: abc123" },
    expected: reason("session_expired"),
  },
] satisfies readonly FailoverClassificationCorpusRow[];
