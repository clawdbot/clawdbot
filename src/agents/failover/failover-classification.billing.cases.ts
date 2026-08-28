import {
  type FailoverClassificationCorpusRow,
  billingSource,
  httpSource,
  matchesSource,
  messageRows,
  failoverSignalRows,
  patternsSource,
  reason,
  retrySource,
  structuredSource,
} from "./failover-classification.corpus.test-support.js";
export const billingCases = [
  // Billing and account entitlement.
  ...failoverSignalRows(retrySource, reason("billing"), [
    // FIXED(refactor-06): legacy retry policy recognized this provider limit class as permanent.
    [
      "retry-go-usage-limit",
      { message: "GoUsageLimitError: usage is unavailable for this account" },
    ],
    // FIXED(refactor-06): legacy retry policy recognized this provider limit class as permanent.
    ["retry-free-usage-limit", { message: "FreeUsageLimitError: free usage is exhausted" }],
    // FIXED(refactor-06): preserve the retry deny-list's account-balance semantics centrally.
    ["retry-no-available-balance", { message: "Your account has no available balance" }],
    // FIXED(refactor-06): preserve the retry deny-list's provider-budget semantics centrally.
    ["retry-out-of-budget", { message: "Provider account is out of budget" }],
  ]),
  ...failoverSignalRows(billingSource, reason("billing"), [
    [
      "billing-anthropic-low-credit",
      { message: "Your credit balance is too low to access the Anthropic API." },
    ],
    ["billing-insufficient-credits", { message: "insufficient credits" }],
    [
      "billing-openrouter-payment-required",
      { provider: "openrouter", message: "Payment Required: insufficient credits" },
    ],
    [
      "billing-openai-insufficient-quota-json",
      {
        provider: "openai",
        message:
          '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}',
      },
    ],
    [
      "billing-together-payment-required",
      {
        provider: "together",
        message:
          "402 Payment Required: The account associated with this API key has reached its maximum allowed monthly spending limit.",
      },
    ],
    [
      "billing-venice-balance",
      {
        provider: "venice",
        message:
          "Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits.",
      },
    ],
    ["billing-more-credits-model", { message: "This model requires more credits to use" }],
    ["billing-more-credits-endpoint", { message: "This endpoint require more credits" }],
    [
      "billing-anthropic-extra-usage",
      {
        provider: "anthropic",
        message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      },
    ],
    [
      "billing-anthropic-extra-usage-required",
      {
        provider: "anthropic",
        message: "Extra usage is required for long context requests.",
      },
    ],
    [
      "billing-anthropic-third-party-extra-usage",
      {
        provider: "anthropic",
        message:
          "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.",
      },
    ],
    ["billing-insufficient-balance-code", { message: "insufficient_balance" }],
    [
      "billing-mbt-balance",
      {
        message: "Insufficient MBT balance. Top up or upgrade your subscription to continue.",
      },
    ],
    [
      "billing-team-credits-spend",
      {
        message:
          "Your team has either used all available credits or reached its monthly spending limit.",
      },
    ],
    [
      "billing-mbt-flat-json",
      {
        message:
          '{"error":"insufficient_balance","message":"Insufficient MBT balance. Top up or upgrade your subscription to continue.","upgradeUrl":"/settings/billing"}',
      },
    ],
    [
      "billing-poe-points",
      {
        provider: "poe",
        message: "402 You've used up your points! Visit https://poe.com/api/keys to get more.",
      },
    ],
    [
      "billing-proxy-subscription",
      { message: "402 No available asset for API access, please purchase a subscription" },
    ],
    [
      "billing-upgrade-plan",
      {
        message:
          "HTTP 402 Payment Required: Your usage limit has been reached. Please upgrade your plan.",
      },
    ],
    ["billing-chinese-balance", { message: "余额不足，请充值" }],
    ["billing-chinese-account-balance", { message: "账户余额不足" }],
    ["billing-chinese-arrears", { message: "账户已欠费" }],
  ]),
  ...failoverSignalRows(matchesSource, reason("billing"), [
    [
      "matches-zai-1311",
      {
        provider: "zai",
        message:
          '{"code":1311,"message":"The model you requested is not available in your current plan"}',
      },
    ],
    [
      "matches-zai-plan-access",
      {
        provider: "zai",
        message:
          "FailoverError: Your current subscription plan does not yet include access to GLM-5V-Turbo",
      },
    ],
    [
      "matches-volcengine-subscription",
      {
        provider: "volcengine",
        message:
          '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}',
      },
    ],
  ]),
  {
    id: "patterns-xai-spending-limit",
    source: patternsSource,
    signal: {
      provider: "xai",
      message:
        '429 {"code":"Some resource has been exhausted","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
    },
    expected: reason("billing"),
  },
  ...failoverSignalRows(structuredSource, reason("billing"), [
    [
      "structured-billing-raw-extra-usage",
      {
        provider: "anthropic",
        message:
          '{"type":"error","error":{"type":"invalid_request_error","message":"You are out of extra usage. Add more at claude.ai/settings/usage"}}',
      },
    ],
    [
      "structured-billing-typed-extra-usage",
      {
        provider: "anthropic",
        errorType: "invalid_request_error",
        message: "You are out of extra usage. Add more at claude.ai/settings/usage",
      },
    ],
    [
      "structured-billing-openai-details",
      {
        provider: "openai",
        message: "You exceeded your current quota, please check your plan and billing details.",
        code: "insufficient_quota",
        errorType: "insufficient_quota",
        details: ['{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}'],
      },
    ],
  ]),
  {
    id: "http-structured-insufficient-quota",
    source: httpSource,
    signal: {
      status: 429,
      code: "insufficient_quota",
      errorType: "rate_limit_error",
      message: "Provider API error (429): Quota exceeded",
      details: ["insufficient_quota"],
    },
    expected: reason("billing"),
  },
  {
    id: "retry-openai-insufficient-quota",
    source: retrySource,
    signal: {
      provider: "openai",
      message:
        "OpenAI API error (429): insufficient_quota: Your account has insufficient quota balance to run this request.",
    },
    expected: reason("billing"),
  },
  {
    // xAI hook corpus.
    id: "xai-403-spending-limit",
    source: "extensions/xai/index.test.ts",
    signal: {
      provider: "xai",
      message:
        '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
    },
    expected: reason("billing"),
  },
  ...failoverSignalRows("extensions/xai/index.test.ts", reason("auth"), [
    [
      "xai-out-of-credits",
      { provider: "xai", message: '403 {"error":"You have run out of credits"}' },
    ],
    [
      "xai-subscription-required",
      { provider: "xai", message: '403 {"error":"You need a Grok subscription"}' },
    ],
  ]),
  ...messageRows(billingSource, reason("billing"), [
    { id: "billing-http-402", message: "HTTP 402 Payment Required" },
    { id: "billing-status-402", message: "status: 402" },
    { id: "billing-error-code-402", message: "error code 402" },
    { id: "billing-returned-402", message: "returned 402" },
    { id: "billing-json-status-402", message: '{"status":402,"type":"error"}' },
    { id: "billing-json-code-402", message: '{"code":402,"message":"payment required"}' },
    {
      id: "billing-json-hard-limit",
      message: '{"error":{"code":402,"message":"billing hard limit reached"}}',
    },
    { id: "billing-plan-billing", message: "plans & billing" },
    { id: "billing-credit-too-low", message: "credit balance too low" },
    {
      id: "billing-plan-limit-exhausted",
      message: "HTTP 402 payment required. Your limit exhausted for this plan.",
    },
    {
      id: "billing-periodic-limit-402",
      message: "402 Payment Required: Weekly/Monthly Limit Exhausted",
    },
    {
      id: "billing-explicit-low-credit-limit",
      message: "Your credit balance is too low. Monthly limit exceeded.",
    },
    {
      id: "billing-explicit-credit-org-limit",
      message: "Insufficient credits. Organization limit reached.",
    },
    {
      id: "billing-api-key-spending-limit",
      message:
        "The account associated with this API key has reached its maximum allowed monthly spending limit.",
    },
    { id: "billing-custom-proxy", message: "402 custom proxy billing failure", status: 402 },
    {
      id: "billing-api-error-insufficient",
      message: '{"type":"error","error":{"type":"api_error","message":"insufficient credits"}}',
    },
    {
      id: "billing-api-error-payment",
      message: '{"type":"error","error":{"type":"api_error","message":"Payment required"}}',
    },
    {
      id: "billing-anthropic-extra-usage-json",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}',
      provider: "anthropic",
    },
    {
      id: "billing-anthropic-extra-required-json",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"Extra usage is required for long context requests."}}',
      provider: "anthropic",
    },
  ]),
  ...messageRows(matchesSource, reason("billing"), [
    {
      id: "matches-zai-1311-spaced",
      message: '{"code": 1311, "message": "model not on plan"}',
      provider: "zai",
    },
    {
      id: "matches-volcengine-subscription-lower",
      message:
        '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid coding plan subscription, or your subscription has expired."}}',
      provider: "volcengine",
    },
  ]),
  ...messageRows(patternsSource, reason("billing"), [
    {
      id: "patterns-html-402",
      message:
        "402 <!doctype html><html><head><title>402 Payment Required</title></head><body><h1>Payment Required</h1><p>Your quota is exhausted.</p></body></html>",
    },
  ]),
] satisfies readonly FailoverClassificationCorpusRow[];
