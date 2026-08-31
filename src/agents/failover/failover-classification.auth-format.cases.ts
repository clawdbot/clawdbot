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
  structuredSource,
} from "./failover-classification.corpus.test-support.js";
export const authFormatCases = [
  // Authentication and authorization.
  ...failoverSignalRows(billingSource, reason("auth"), [
    [
      "billing-no-anthropic-credentials",
      { message: 'No credentials found for profile "anthropic:default".' },
    ],
    [
      "billing-no-openai-api-key",
      { provider: "openai", message: "No API key found for profile openai." },
    ],
    [
      "billing-oauth-refresh-failed",
      {
        provider: "anthropic",
        message:
          "OAuth token refresh failed for anthropic: Failed to refresh OAuth token for anthropic. Please try again or re-authenticate.",
      },
    ],
    ["billing-could-not-authenticate-key", { message: "could not authenticate api key" }],
    ["billing-token-account-id", { message: "Failed to extract accountId from token" }],
    [
      "billing-insufficient-permissions",
      { message: "You have insufficient permissions for this operation." },
    ],
    ["billing-missing-scope", { message: "Missing scopes: model.request" }],
  ]),
  ...failoverSignalRows(billingSource, reason("auth_permanent"), [
    ["billing-api-key-revoked", { message: "Your api key has been revoked" }],
    [
      "billing-oauth-org-disabled",
      { message: "OAuth authentication is currently not allowed for this organization" },
    ],
  ]),
  ...failoverSignalRows(billingSource, reason("auth"), [
    ["billing-chinese-model-denied", { message: "403 您无权访问glm-5.1。" }],
    ["billing-chinese-key-banned", { message: "当前ak因违规请求被禁止访问该模型" }],
    ["billing-chinese-ce-011", { message: '{"success":false,"code":"CE-011"}' }],
    ["billing-chinese-auth-failed", { message: "鉴权失败，请检查API Key" }],
  ]),
  ...failoverSignalRows(matchesSource, reason("auth"), [
    // #48988
    [
      "matches-zai-1113",
      {
        provider: "zai",
        message: '{"code":1113,"message":"invalid api endpoint or credentials"}',
      },
    ],
    // #114784
    [
      "matches-google-invalid-key",
      {
        provider: "google",
        message:
          "Google Generative AI API error (400): API key not valid. Please pass a valid API key. [code=INVALID_ARGUMENT]",
      },
    ],
    [
      "matches-google-api-key-invalid-code",
      { provider: "google", message: '{"code":"API_KEY_INVALID"}' },
    ],
  ]),
  ...failoverSignalRows(patternsSource, reason("auth"), [
    [
      "patterns-html-401",
      {
        status: 401,
        message:
          "<!doctype html><html><head><title>401 Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>",
      },
    ],
    [
      "patterns-html-403",
      {
        status: 403,
        message:
          "<!doctype html><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>",
      },
    ],
  ]),
  ...failoverSignalRows(structuredSource, reason("auth"), [
    [
      "structured-403-quota-without-hook",
      {
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_QUOTA_EXHAUSTED",
        message: "Forbidden",
      },
    ],
    [
      "structured-403-rate-without-hook",
      {
        provider: "demo-provider",
        status: 403,
        code: "PROVIDER_RATE_LIMITED",
        message: "Forbidden",
      },
    ],
    [
      "structured-message-prefix-403",
      { provider: "demo-provider", message: "403 concurrency limit breached" },
    ],
  ]),
  {
    id: "http-invalid-api-key",
    source: httpSource,
    signal: { status: 401, message: "Invalid API key" },
    expected: reason("auth"),
  },
  {
    id: "http-invalid-client-secret",
    source: httpSource,
    signal: {
      status: 400,
      code: "invalid_request",
      message: "AADSTS7000215: Invalid client secret provided.",
    },
    expected: reason("format"),
  },
  {
    id: "retry-openai-auth",
    source: retrySource,
    signal: {
      provider: "openai",
      message: "OpenAI API error (401): Invalid authentication credentials",
    },
    expected: reason("auth"),
  },
  {
    id: "retry-azure-org-auth",
    source: retrySource,
    signal: {
      provider: "azure-openai",
      message:
        "Azure OpenAI API error (403): OAuth authentication is currently not allowed for this organization",
    },
    expected: reason("auth_permanent"),
  },
  {
    id: "errors-claude-cli-logged-out",
    source: errorsSource,
    signal: { provider: "claude-cli", message: "Not logged in · Please run /login" },
    expected: reason("auth"),
  },
  {
    id: "xai-invalid-api-key",
    source: "extensions/xai/index.test.ts",
    signal: {
      provider: "xai",
      message:
        '400 {"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***en. You can obtain an API key from https://console.x.ai."}',
    },
    expected: reason("auth"),
  },
  ...messageRows(billingSource, reason("auth"), [
    { id: "billing-invalid-api-key-code", message: "invalid_api_key" },
    { id: "billing-permission-error", message: "permission_error" },
    { id: "billing-reauthenticate", message: "Please re-authenticate to continue." },
    { id: "billing-validate-credentials", message: "could not validate credentials" },
    { id: "billing-http401-invalid-key", message: "HTTP 401: invalid_api_key" },
    { id: "billing-http410-authentication", message: "HTTP 410: authentication failed" },
    {
      id: "billing-api-error-invalid-key",
      message: '{"type":"error","error":{"type":"api_error","message":"invalid api key"}}',
    },
    {
      id: "billing-api-error-unauthorized",
      message: '{"type":"error","error":{"type":"api_error","message":"unauthorized"}}',
    },
    {
      id: "billing-api-error-permission",
      message: '{"type":"error","error":{"type":"api_error","message":"permission_error"}}',
    },
    { id: "billing-chinese-no-access", message: "无权访问该模型" },
    { id: "billing-chinese-authentication", message: "认证失败" },
    { id: "billing-chinese-key-invalid", message: "密钥无效" },
  ]),
  ...messageRows(billingSource, reason("auth_permanent"), [
    { id: "billing-key-disabled", message: "key has been disabled" },
    { id: "billing-account-deactivated", message: "account has been deactivated" },
    {
      id: "billing-api-error-org-auth",
      message:
        '{"type":"error","error":{"type":"api_error","message":"permission_error: OAuth authentication is currently not allowed for this organization"}}',
    },
  ]),
  ...messageRows(matchesSource, reason("auth"), [
    { id: "matches-invalid-api-key-error", message: "invalid_api_key_error" },
    { id: "matches-api-key-is-invalid", message: "API key is invalid" },
    {
      id: "matches-api-key-invalid-error-code",
      message: '{"code":"API_KEY_INVALID_ERROR"}',
      provider: "google",
    },
  ]),
  {
    id: "patterns-html-407",
    source: patternsSource,
    signal: {
      status: 407,
      message:
        "<!doctype html><html><head><title>407 Proxy Authentication Required</title></head><body><h1>Proxy Authentication Required</h1></body></html>",
    },
    expected: reason("auth"),
  },
  {
    id: "structured-nested-quota-without-hook",
    source: structuredSource,
    signal: {
      provider: "demo-provider",
      status: 403,
      errorType: "PROVIDER_QUOTA_EXHAUSTED",
      message: "Forbidden",
    },
    expected: reason("auth"),
  },
  // Request shape and replay format.
  ...failoverSignalRows(billingSource, reason("format"), [
    ["billing-invalid-request-format", { message: "invalid request format" }],
    [
      "billing-prefill-unsupported",
      {
        message:
          "This model does not support assistant message prefill. The conversation must end with a user message.",
      },
    ],
    ["billing-pattern-string", { message: "string should match pattern" }],
  ]),
  {
    // #91710
    id: "matches-harness-provider",
    source: matchesSource,
    signal: {
      message:
        'Requested agent harness "codex" does not support openai/gpt-5.3-codex (provider is not one of: codex).',
    },
    expected: reason("format"),
  },
  ...failoverSignalRows(structuredSource, reason("format"), [
    [
      "structured-invalid-request-raw",
      {
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"messages.27.content.1: thinking blocks cannot be modified"}}',
      },
    ],
    [
      "structured-invalid-request-typed",
      {
        provider: "anthropic",
        errorType: "invalid_request_error",
        message: "thinking blocks cannot be modified",
      },
    ],
    // #118615, #116967
    [
      "structured-invalid-signature",
      {
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
      },
    ],
    [
      "structured-invalid-signature-carrier",
      {
        provider: "anthropic",
        message:
          'Validation error: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
      },
    ],
  ]),
  {
    id: "openrouter-image-input",
    source: openRouterSource,
    signal: {
      provider: "openrouter",
      status: 404,
      message: "No endpoints found that support image input",
    },
    expected: reason("format"),
  },
  {
    id: "bedrock-deprecated-temperature",
    source: "extensions/amazon-bedrock/index.test.ts",
    signal: {
      provider: "amazon-bedrock",
      message:
        'ValidationException: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}',
    },
    expected: null,
  },
  {
    id: "billing-context-reasoning-required",
    source: billingSource,
    signal: { message: "400 Reasoning is mandatory for this endpoint and cannot be disabled." },
    expected: reason("format"),
  },
  {
    id: "errors-invalid-request-json-syntax",
    source: errorsSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"Expected value in JSON at position 12 for messages.0.content"}}',
    },
    expected: reason("format"),
  },
  {
    id: "http-quota-normalized",
    source: httpSource,
    signal: {
      status: 429,
      code: "quota_exceeded",
      message:
        "Provider API error (429): Quota exceeded [code=quota_exceeded] [request_id=req_123]",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "http-legacy-bad-request-normalized",
    source: httpSource,
    signal: {
      status: 400,
      code: "invalid_request",
      message:
        "Legacy provider error (HTTP 400): Bad request [code=invalid_request] [request_id=req_legacy]",
    },
    expected: reason("format"),
  },
] satisfies readonly FailoverClassificationCorpusRow[];
