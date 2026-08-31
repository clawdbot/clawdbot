import {
  type FailoverClassificationCorpusRow,
  billingSource,
  matchesSource,
  messageRows,
  failoverSignalRows,
  openRouterSource,
  patternsSource,
  reason,
  retrySource,
  structuredSource,
} from "./failover-classification.corpus.test-support.js";
export const rateLimitOverloadCases = [
  // Rate limits and temporary quotas.
  ...failoverSignalRows(billingSource, reason("rate_limit"), [
    [
      "billing-openai-rate-limit",
      {
        provider: "openai",
        message:
          "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min. Current: 3.000000 / min.",
      },
    ],
    [
      "billing-gemini-resource-exhausted",
      {
        provider: "google",
        message: "RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).",
      },
    ],
    [
      "billing-groq-too-many-requests",
      {
        provider: "groq",
        message: "429 Too Many Requests: Too many requests were sent in a given timeframe.",
      },
    ],
    [
      "billing-model-cooldown",
      { message: "model_cooldown: All credentials for model gpt-5 are cooling down" },
    ],
    [
      "billing-chatgpt-usage-limit",
      { provider: "openai", message: "You have hit your ChatGPT usage limit (plus plan)" },
    ],
    [
      "billing-bedrock-tokens-per-day",
      {
        provider: "amazon-bedrock",
        message: "AWS Bedrock: Too many tokens per day. Please try again tomorrow.",
      },
    ],
    // #33785
    [
      "billing-zhipu-periodic-limit",
      {
        provider: "zai",
        message:
          "LLM error 1310: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-03-06 22:19:54 (request_id: 20260303141547610b7f574d1b44cb)",
      },
    ],
    [
      "billing-subscription-quota-refresh",
      {
        message:
          "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
      },
    ],
    ["billing-chinese-too-frequent", { message: "请求过于频繁，请稍后重试" }],
    ["billing-chinese-frequency-limit", { message: "调用频率超限" }],
    ["billing-chinese-quota-exhausted", { message: "配额已用尽" }],
    ["billing-chinese-top-up", { message: "额度不足，请充值" }],
  ]),
  ...failoverSignalRows(matchesSource, reason("rate_limit"), [
    ["matches-rate-limit", { message: "rate limit exceeded" }],
    // #98101
    [
      "matches-zai-1305-429",
      {
        provider: "zai",
        message:
          '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}',
      },
    ],
  ]),
  ...failoverSignalRows(patternsSource, reason("rate_limit"), [
    [
      "patterns-bedrock-throttling",
      { provider: "amazon-bedrock", message: "ThrottlingException: Too many requests" },
    ],
    [
      "patterns-bedrock-concurrency",
      {
        provider: "amazon-bedrock",
        message: "ThrottlingException: Too many concurrent requests",
      },
    ],
    ["patterns-concurrency-limit", { message: "concurrency limit has been reached" }],
    // FIXED(refactor-02): was null, now rate_limit
    ["patterns-concurrency-limit-breached", { message: "concurrency limit breached" }],
    // FIXED(refactor-02): was null, now rate_limit
    ["patterns-concurrency-limit-was-reached", { message: "concurrency limit was reached" }],
    [
      "patterns-cloudflare-workers-quota",
      { message: "workers_ai gateway error: quota limit exceeded" },
    ],
    [
      "patterns-json-rate-limit",
      {
        message: '429 {"error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}',
      },
    ],
  ]),
  {
    id: "structured-unstructured-rate-limit",
    source: structuredSource,
    signal: { provider: "demo-provider", message: "invalid_api_key" },
    expected: reason("auth"),
  },
  ...failoverSignalRows(retrySource, reason("rate_limit"), [
    ["retry-429-temporary", { message: "429 temporary provider response" }],
    // FIXED(refactor-06): separator-free provider code now shares the canonical rate-limit path.
    [
      "retry-resource-exhausted-worker",
      { message: "ResourceExhausted: Worker local total request limit reached" },
    ],
  ]),
  ...failoverSignalRows("src/agents/live-auth-keys.ts", reason("rate_limit"), [
    // FIXED(refactor-06): live key rotation already treated the spaced form as rate limiting.
    ["live-auth-resource-exhausted-spaced", { message: "resource exhausted" }],
    // FIXED(refactor-06): preserve the provider-code spelling used by live key rotation.
    ["live-auth-quota-exceeded-code", { message: "quota_exceeded" }],
  ]),
  ...failoverSignalRows(retrySource, reason("rate_limit"), [
    [
      "retry-resource-exhausted-capacity",
      { message: "resource_exhausted: transient worker capacity exhausted" },
    ],
    [
      "retry-daily-limit",
      { message: "429 You exceeded your daily request limit. Please try again in 24 hours." },
    ],
    ["retry-retry-after-hours", { message: "429 RPM limit exceeded; Retry-After: 2 hours" }],
    [
      "retry-resource-exhausted-quota",
      {
        message:
          "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per minute; please retry your request",
      },
    ],
    [
      "retry-openai-resource-exhausted",
      {
        provider: "openai",
        message:
          "OpenAI API error (429): RESOURCE_EXHAUSTED: Quota exceeded for requests per minute; please retry your request",
      },
    ],
  ]),
  {
    id: "openrouter-stream-rate-limit",
    source: openRouterSource,
    signal: {
      provider: "openrouter",
      status: 429,
      errorType: "rate_limit_exceeded",
      message: "Rate limit exceeded",
    },
    expected: reason("rate_limit"),
  },
  ...failoverSignalRows("extensions/amazon-bedrock-mantle/index.test.ts", reason("rate_limit"), [
    ["mantle-rate-limit", { provider: "amazon-bedrock-mantle", message: "rate_limit exceeded" }],
    ["mantle-429", { provider: "amazon-bedrock-mantle", message: "429 Too Many Requests" }],
  ]),
  {
    id: "xai-rate-limit-payload",
    source: "extensions/xai/index.test.ts",
    signal: {
      provider: "xai",
      message: '429 {"code":"Some resource has been exhausted","error":"Rate limit exceeded"}',
    },
    expected: reason("rate_limit"),
  },
  ...messageRows(billingSource, reason("rate_limit"), [
    {
      id: "billing-rate-limit-org-tpd",
      message: "request reached organization TPD rate limit, current: 1506556, limit: 1500000",
    },
    { id: "billing-rate-limit-too-many", message: "too many requests" },
    {
      id: "billing-rate-limit-account",
      message: "This request would exceed your account's rate limit",
    },
    {
      id: "billing-rate-limit-429-request",
      message: "429 Too Many Requests: request exceeds rate limit",
    },
    { id: "billing-monthly-spend", message: "Monthly spend limit reached.", status: 402 },
    { id: "billing-weekly-usage", message: "Weekly usage limit exhausted." },
    { id: "billing-daily-reset", message: "Daily limit reached, resets tomorrow." },
    { id: "billing-org-spend", message: "Organization spending limit exceeded.", status: 402 },
    { id: "billing-workspace-spend", message: "Workspace spend limit reached.", status: 402 },
    {
      id: "billing-org-period",
      message: "Organization limit exceeded for this billing period.",
      status: 402,
    },
    {
      id: "billing-monthly-settings",
      message:
        "402 Payment Required: Monthly spend limit reached. Please visit your billing settings.",
    },
    { id: "billing-http402-rate-limit", message: "HTTP 402 Payment Required: rate limit exceeded" },
    { id: "billing-weekly-monthly", message: "LLM error: weekly/monthly limit reached" },
    { id: "billing-monthly-limit", message: "LLM error: monthly limit reached" },
    { id: "billing-daily-limit", message: "LLM error: daily limit exceeded" },
    { id: "billing-chinese-frequency", message: "频率限制" },
    { id: "billing-chinese-quota-insufficient", message: "配额不足" },
    { id: "billing-chinese-credit-exhausted", message: "额度已用尽" },
  ]),
  ...messageRows(retrySource, reason("rate_limit"), [
    { id: "retry-monthly-usage-limit", message: "Monthly usage limit reached" },
    {
      id: "retry-rate-limit-six-hours",
      message: "rate limit reached for requests. Retry after 6h.",
    },
    { id: "retry-rate-limit-90-minutes", message: "rate limit reached; Retry-After: 90 minutes" },
  ]),
  {
    id: "retry-429-insufficient-quota-short",
    source: retrySource,
    signal: { message: "429 insufficient_quota" },
    expected: reason("billing"),
  },
  ...messageRows(patternsSource, reason("rate_limit"), [
    {
      id: "patterns-html-429",
      message:
        "429 <!doctype html><html><head><title>429 Too Many Requests</title></head><body><h1>Too Many Requests</h1><p>Rate limit exceeded.</p></body></html>",
    },
  ]),
  {
    id: "xai-generic-429",
    source: "extensions/xai/index.test.ts",
    signal: { provider: "xai", message: "429 Too Many Requests" },
    expected: reason("rate_limit"),
  },
  // Provider overload.
  ...failoverSignalRows(billingSource, reason("overloaded"), [
    [
      "billing-anthropic-overloaded",
      {
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}',
      },
    ],
    [
      "billing-together-overloaded",
      {
        provider: "together",
        message:
          "503 Engine Overloaded: The server is experiencing a high volume of requests and is temporarily overloaded.",
      },
    ],
    [
      "billing-groq-service-unavailable",
      {
        provider: "groq",
        message:
          "503 Service Unavailable: The server is temporarily unable to handle the request due to overloading or maintenance.",
      },
    ],
    [
      "billing-high-demand",
      {
        message: "This model is currently experiencing high demand. Please try again later.",
      },
    ],
    ["billing-service-capacity", { message: "service unavailable due to capacity limits" }],
    [
      "billing-json-model-overloaded",
      {
        message:
          '{"error":{"code":503,"message":"The model is overloaded. Please try later","status":"UNAVAILABLE"}}',
      },
    ],
    ["billing-529-busy", { message: "529 API is busy" }],
    ["billing-chinese-overload", { message: "服务过载，请稍后重试" }],
    ["billing-chinese-high-load", { message: "当前负载过高" }],
  ]),
  ...failoverSignalRows(matchesSource, reason("overloaded"), [
    [
      "matches-openai-capacity",
      { message: "Selected model is at capacity. Please try a different model." },
    ],
    [
      "matches-openrouter-high-load",
      {
        provider: "openrouter",
        message: "The service is currently experiencing high load and cannot process your request.",
      },
    ],
    // #48988
    [
      "matches-zhipu-overload-cn",
      { provider: "zai", message: "[1305][该模型当前访问量过大，请您稍后再试]" },
    ],
  ]),
  {
    id: "patterns-bedrock-model-not-ready",
    source: patternsSource,
    signal: {
      provider: "amazon-bedrock",
      message: "ModelNotReadyException: model is not ready",
    },
    expected: reason("overloaded"),
  },
  {
    id: "mantle-overloaded",
    source: "extensions/amazon-bedrock-mantle/index.test.ts",
    signal: { provider: "amazon-bedrock-mantle", message: "overloaded_error" },
    expected: reason("overloaded"),
  },
  ...messageRows(billingSource, reason("overloaded"), [
    { id: "billing-529-retry", message: "529 Please try again" },
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
