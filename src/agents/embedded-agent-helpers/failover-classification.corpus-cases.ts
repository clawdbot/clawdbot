import type { FailoverClassification, FailoverSignal } from "./errors.js";
import type { FailoverReason } from "./types.js";

export type FailoverClassificationCorpusRow = {
  id: string;
  source: string;
  signal: FailoverSignal;
  expected: FailoverClassification | null;
};

const reason = (value: FailoverReason): FailoverClassification => ({
  kind: "reason",
  reason: value,
});
const contextOverflow: FailoverClassification = { kind: "context_overflow" };

function messageRows(
  source: string,
  expected: FailoverClassification | null,
  rows: readonly { id: string; message: string; provider?: string; status?: number }[],
): FailoverClassificationCorpusRow[] {
  return rows.map(({ id, message, provider, status }) => ({
    id,
    source,
    signal: { message, ...(provider ? { provider } : {}), ...(status ? { status } : {}) },
    expected,
  }));
}

const billingSource = "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts";
const matchesSource = "src/agents/embedded-agent-helpers/failover-matches.test.ts";
const patternsSource = "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts";
const errorsSource = "src/agents/embedded-agent-helpers/errors.test.ts";
const structuredSource =
  "src/agents/embedded-agent-helpers/errors-provider-structured-signals.test.ts";
const httpSource = "src/agents/provider-http-errors.test.ts";
const openRouterSource = "src/agents/openrouter-error-classification.integration.test.ts";
const retrySource = "src/llm/utils/retry.test.ts";

export const failoverClassificationCorpus = [
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

  // Billing and account entitlement.
  {
    id: "billing-anthropic-low-credit",
    source: billingSource,
    signal: { message: "Your credit balance is too low to access the Anthropic API." },
    expected: reason("billing"),
  },
  {
    id: "billing-insufficient-credits",
    source: billingSource,
    signal: { message: "insufficient credits" },
    expected: reason("billing"),
  },
  {
    id: "billing-openrouter-payment-required",
    source: billingSource,
    signal: { provider: "openrouter", message: "Payment Required: insufficient credits" },
    expected: reason("billing"),
  },
  {
    id: "billing-openai-insufficient-quota-json",
    source: billingSource,
    signal: {
      provider: "openai",
      message:
        '{"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}',
    },
    expected: reason("billing"),
  },
  {
    id: "billing-together-payment-required",
    source: billingSource,
    signal: {
      provider: "together",
      message:
        "402 Payment Required: The account associated with this API key has reached its maximum allowed monthly spending limit.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-venice-balance",
    source: billingSource,
    signal: {
      provider: "venice",
      message:
        "Insufficient USD or Diem balance to complete request. Visit https://venice.ai/settings/api to add credits.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-more-credits-model",
    source: billingSource,
    signal: { message: "This model requires more credits to use" },
    expected: reason("billing"),
  },
  {
    id: "billing-more-credits-endpoint",
    source: billingSource,
    signal: { message: "This endpoint require more credits" },
    expected: reason("billing"),
  },
  {
    id: "billing-anthropic-extra-usage",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-anthropic-extra-usage-required",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message: "Extra usage is required for long context requests.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-anthropic-third-party-extra-usage",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-insufficient-balance-code",
    source: billingSource,
    signal: { message: "insufficient_balance" },
    expected: reason("billing"),
  },
  {
    id: "billing-mbt-balance",
    source: billingSource,
    signal: {
      message: "Insufficient MBT balance. Top up or upgrade your subscription to continue.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-team-credits-spend",
    source: billingSource,
    signal: {
      message:
        "Your team has either used all available credits or reached its monthly spending limit.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-mbt-flat-json",
    source: billingSource,
    signal: {
      message:
        '{"error":"insufficient_balance","message":"Insufficient MBT balance. Top up or upgrade your subscription to continue.","upgradeUrl":"/settings/billing"}',
    },
    expected: reason("billing"),
  },
  {
    id: "billing-poe-points",
    source: billingSource,
    signal: {
      provider: "poe",
      message: "402 You've used up your points! Visit https://poe.com/api/keys to get more.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-proxy-subscription",
    source: billingSource,
    signal: { message: "402 No available asset for API access, please purchase a subscription" },
    expected: reason("billing"),
  },
  {
    id: "billing-upgrade-plan",
    source: billingSource,
    signal: {
      message:
        "HTTP 402 Payment Required: Your usage limit has been reached. Please upgrade your plan.",
    },
    expected: reason("billing"),
  },
  {
    id: "billing-chinese-balance",
    source: billingSource,
    signal: { message: "余额不足，请充值" },
    expected: reason("billing"),
  },
  {
    id: "billing-chinese-account-balance",
    source: billingSource,
    signal: { message: "账户余额不足" },
    expected: reason("billing"),
  },
  {
    id: "billing-chinese-arrears",
    source: billingSource,
    signal: { message: "账户已欠费" },
    expected: reason("billing"),
  },
  {
    id: "matches-zai-1311",
    source: matchesSource,
    signal: {
      provider: "zai",
      message:
        '{"code":1311,"message":"The model you requested is not available in your current plan"}',
    },
    expected: reason("billing"),
  },
  {
    id: "matches-zai-plan-access",
    source: matchesSource,
    signal: {
      provider: "zai",
      message:
        "FailoverError: Your current subscription plan does not yet include access to GLM-5V-Turbo",
    },
    expected: reason("billing"),
  },
  {
    id: "matches-volcengine-subscription",
    source: matchesSource,
    signal: {
      provider: "volcengine",
      message:
        '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid CodingPlan subscription, or your subscription has expired."}}',
    },
    expected: reason("billing"),
  },
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
  {
    id: "structured-billing-raw-extra-usage",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"You are out of extra usage. Add more at claude.ai/settings/usage"}}',
    },
    expected: reason("billing"),
  },
  {
    id: "structured-billing-typed-extra-usage",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      errorType: "invalid_request_error",
      message: "You are out of extra usage. Add more at claude.ai/settings/usage",
    },
    expected: reason("billing"),
  },
  {
    id: "structured-billing-openai-details",
    source: structuredSource,
    signal: {
      provider: "openai",
      message: "You exceeded your current quota, please check your plan and billing details.",
      code: "insufficient_quota",
      errorType: "insufficient_quota",
      details: ['{"error":{"code":"insufficient_quota","type":"insufficient_quota"}}'],
    },
    expected: reason("billing"),
  },
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
  {
    id: "xai-out-of-credits",
    source: "extensions/xai/index.test.ts",
    signal: { provider: "xai", message: '403 {"error":"You have run out of credits"}' },
    expected: reason("auth"),
  },
  {
    id: "xai-subscription-required",
    source: "extensions/xai/index.test.ts",
    signal: { provider: "xai", message: '403 {"error":"You need a Grok subscription"}' },
    expected: reason("auth"),
  },
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

  // Rate limits and temporary quotas.
  {
    id: "billing-openai-rate-limit",
    source: billingSource,
    signal: {
      provider: "openai",
      message:
        "Rate limit reached for gpt-4.1-mini in organization org_test on requests per min. Limit: 3.000000 / min. Current: 3.000000 / min.",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-gemini-resource-exhausted",
    source: billingSource,
    signal: {
      provider: "google",
      message: "RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-groq-too-many-requests",
    source: billingSource,
    signal: {
      provider: "groq",
      message: "429 Too Many Requests: Too many requests were sent in a given timeframe.",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-model-cooldown",
    source: billingSource,
    signal: { message: "model_cooldown: All credentials for model gpt-5 are cooling down" },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-chatgpt-usage-limit",
    source: billingSource,
    signal: { provider: "openai", message: "You have hit your ChatGPT usage limit (plus plan)" },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-bedrock-tokens-per-day",
    source: billingSource,
    signal: {
      provider: "amazon-bedrock",
      message: "AWS Bedrock: Too many tokens per day. Please try again tomorrow.",
    },
    expected: reason("rate_limit"),
  },
  {
    // #33785
    id: "billing-zhipu-periodic-limit",
    source: billingSource,
    signal: {
      provider: "zai",
      message:
        "LLM error 1310: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-03-06 22:19:54 (request_id: 20260303141547610b7f574d1b44cb)",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-subscription-quota-refresh",
    source: billingSource,
    signal: {
      message:
        "402 You have reached your subscription quota limit. Please wait for automatic quota refresh in the rolling time window, upgrade to a higher plan, or use a Pay-As-You-Go API Key for unlimited access.",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-chinese-too-frequent",
    source: billingSource,
    signal: { message: "请求过于频繁，请稍后重试" },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-chinese-frequency-limit",
    source: billingSource,
    signal: { message: "调用频率超限" },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-chinese-quota-exhausted",
    source: billingSource,
    signal: { message: "配额已用尽" },
    expected: reason("rate_limit"),
  },
  {
    id: "billing-chinese-top-up",
    source: billingSource,
    signal: { message: "额度不足，请充值" },
    expected: reason("rate_limit"),
  },
  {
    id: "matches-rate-limit",
    source: matchesSource,
    signal: { message: "rate limit exceeded" },
    expected: reason("rate_limit"),
  },
  {
    // #98101
    id: "matches-zai-1305-429",
    source: matchesSource,
    signal: {
      provider: "zai",
      message:
        '429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}',
    },
    expected: reason("rate_limit"),
  },
  {
    id: "patterns-bedrock-throttling",
    source: patternsSource,
    signal: { provider: "amazon-bedrock", message: "ThrottlingException: Too many requests" },
    expected: reason("rate_limit"),
  },
  {
    id: "patterns-bedrock-concurrency",
    source: patternsSource,
    signal: {
      provider: "amazon-bedrock",
      message: "ThrottlingException: Too many concurrent requests",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "patterns-concurrency-limit",
    source: patternsSource,
    signal: { message: "concurrency limit has been reached" },
    expected: reason("rate_limit"),
  },
  {
    id: "patterns-cloudflare-workers-quota",
    source: patternsSource,
    signal: { message: "workers_ai gateway error: quota limit exceeded" },
    expected: reason("rate_limit"),
  },
  {
    id: "patterns-json-rate-limit",
    source: patternsSource,
    signal: {
      message: '429 {"error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}',
    },
    expected: reason("rate_limit"),
  },
  {
    id: "structured-unstructured-rate-limit",
    source: structuredSource,
    signal: { provider: "demo-provider", message: "invalid_api_key" },
    expected: reason("auth"),
  },
  {
    id: "retry-429-temporary",
    source: retrySource,
    signal: { message: "429 temporary provider response" },
    expected: reason("rate_limit"),
  },
  {
    id: "retry-resource-exhausted-worker",
    source: retrySource,
    signal: { message: "ResourceExhausted: Worker local total request limit reached" },
    expected: null,
  },
  {
    id: "retry-resource-exhausted-capacity",
    source: retrySource,
    signal: { message: "resource_exhausted: transient worker capacity exhausted" },
    expected: reason("rate_limit"),
  },
  {
    id: "retry-daily-limit",
    source: retrySource,
    signal: { message: "429 You exceeded your daily request limit. Please try again in 24 hours." },
    expected: reason("rate_limit"),
  },
  {
    id: "retry-retry-after-hours",
    source: retrySource,
    signal: { message: "429 RPM limit exceeded; Retry-After: 2 hours" },
    expected: reason("rate_limit"),
  },
  {
    id: "retry-resource-exhausted-quota",
    source: retrySource,
    signal: {
      message:
        "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per minute; please retry your request",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "retry-openai-resource-exhausted",
    source: retrySource,
    signal: {
      provider: "openai",
      message:
        "OpenAI API error (429): RESOURCE_EXHAUSTED: Quota exceeded for requests per minute; please retry your request",
    },
    expected: reason("rate_limit"),
  },
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
  {
    id: "mantle-rate-limit",
    source: "extensions/amazon-bedrock-mantle/index.test.ts",
    signal: { provider: "amazon-bedrock-mantle", message: "rate_limit exceeded" },
    expected: reason("rate_limit"),
  },
  {
    id: "mantle-429",
    source: "extensions/amazon-bedrock-mantle/index.test.ts",
    signal: { provider: "amazon-bedrock-mantle", message: "429 Too Many Requests" },
    expected: reason("rate_limit"),
  },
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
  {
    id: "billing-anthropic-overloaded",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_test"}',
    },
    expected: reason("overloaded"),
  },
  {
    id: "billing-together-overloaded",
    source: billingSource,
    signal: {
      provider: "together",
      message:
        "503 Engine Overloaded: The server is experiencing a high volume of requests and is temporarily overloaded.",
    },
    expected: reason("overloaded"),
  },
  {
    id: "billing-groq-service-unavailable",
    source: billingSource,
    signal: {
      provider: "groq",
      message:
        "503 Service Unavailable: The server is temporarily unable to handle the request due to overloading or maintenance.",
    },
    expected: reason("overloaded"),
  },
  {
    id: "billing-high-demand",
    source: billingSource,
    signal: {
      message: "This model is currently experiencing high demand. Please try again later.",
    },
    expected: reason("overloaded"),
  },
  {
    id: "billing-service-capacity",
    source: billingSource,
    signal: { message: "service unavailable due to capacity limits" },
    expected: reason("overloaded"),
  },
  {
    id: "billing-json-model-overloaded",
    source: billingSource,
    signal: {
      message:
        '{"error":{"code":503,"message":"The model is overloaded. Please try later","status":"UNAVAILABLE"}}',
    },
    expected: reason("overloaded"),
  },
  {
    id: "billing-529-busy",
    source: billingSource,
    signal: { message: "529 API is busy" },
    expected: reason("overloaded"),
  },
  {
    id: "billing-chinese-overload",
    source: billingSource,
    signal: { message: "服务过载，请稍后重试" },
    expected: reason("overloaded"),
  },
  {
    id: "billing-chinese-high-load",
    source: billingSource,
    signal: { message: "当前负载过高" },
    expected: reason("overloaded"),
  },
  {
    id: "matches-openai-capacity",
    source: matchesSource,
    signal: { message: "Selected model is at capacity. Please try a different model." },
    expected: reason("overloaded"),
  },
  {
    id: "matches-openrouter-high-load",
    source: matchesSource,
    signal: {
      provider: "openrouter",
      message: "The service is currently experiencing high load and cannot process your request.",
    },
    expected: reason("overloaded"),
  },
  {
    // #48988
    id: "matches-zhipu-overload-cn",
    source: matchesSource,
    signal: { provider: "zai", message: "[1305][该模型当前访问量过大，请您稍后再试]" },
    expected: reason("overloaded"),
  },
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
    id: "billing-openrouter-provider-returned",
    source: billingSource,
    signal: { provider: "openrouter", message: "Provider returned error" },
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
    expected: reason("timeout"),
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
  ...messageRows(billingSource, reason("timeout"), [
    { id: "billing-status-499", message: "499 Client Closed Request" },
    { id: "billing-status-500", message: "500 Internal Server Error" },
    { id: "billing-status-502", message: "502 Bad Gateway" },
    { id: "billing-status-503", message: "503 Service Unavailable" },
    { id: "billing-status-504", message: "504 Gateway Timeout" },
    { id: "billing-llm-service-unavailable", message: "LLM error: service unavailable" },
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
      id: "billing-api-error-unavailable",
      message:
        '{"type":"error","error":{"type":"api_error","message":"Service temporarily unavailable"}}',
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
  ...messageRows(retrySource, reason("timeout"), [
    { id: "retry-http-500", message: "HTTP 500 temporary provider response" },
    { id: "retry-503", message: "503: temporary provider response" },
    { id: "retry-524", message: "524 status code (no body)" },
    {
      id: "retry-billing-service",
      message: "503 billing service unavailable; please retry your request",
    },
    {
      id: "retry-subscription-service",
      message: "503 subscription service unavailable while checking quota",
    },
    { id: "retry-503-retry-after", message: "503 Service Unavailable; Retry-After: 120 seconds" },
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

  // Authentication and authorization.
  {
    id: "billing-no-anthropic-credentials",
    source: billingSource,
    signal: { message: 'No credentials found for profile "anthropic:default".' },
    expected: reason("auth"),
  },
  {
    id: "billing-no-openai-api-key",
    source: billingSource,
    signal: { provider: "openai", message: "No API key found for profile openai." },
    expected: reason("auth"),
  },
  {
    id: "billing-oauth-refresh-failed",
    source: billingSource,
    signal: {
      provider: "anthropic",
      message:
        "OAuth token refresh failed for anthropic: Failed to refresh OAuth token for anthropic. Please try again or re-authenticate.",
    },
    expected: reason("auth"),
  },
  {
    id: "billing-could-not-authenticate-key",
    source: billingSource,
    signal: { message: "could not authenticate api key" },
    expected: reason("auth"),
  },
  {
    id: "billing-token-account-id",
    source: billingSource,
    signal: { message: "Failed to extract accountId from token" },
    expected: reason("auth"),
  },
  {
    id: "billing-insufficient-permissions",
    source: billingSource,
    signal: { message: "You have insufficient permissions for this operation." },
    expected: reason("auth"),
  },
  {
    id: "billing-missing-scope",
    source: billingSource,
    signal: { message: "Missing scopes: model.request" },
    expected: reason("auth"),
  },
  {
    id: "billing-api-key-revoked",
    source: billingSource,
    signal: { message: "Your api key has been revoked" },
    expected: reason("auth_permanent"),
  },
  {
    id: "billing-oauth-org-disabled",
    source: billingSource,
    signal: { message: "OAuth authentication is currently not allowed for this organization" },
    expected: reason("auth_permanent"),
  },
  {
    id: "billing-chinese-model-denied",
    source: billingSource,
    signal: { message: "403 您无权访问glm-5.1。" },
    expected: reason("auth"),
  },
  {
    id: "billing-chinese-key-banned",
    source: billingSource,
    signal: { message: "当前ak因违规请求被禁止访问该模型" },
    expected: reason("auth"),
  },
  {
    id: "billing-chinese-ce-011",
    source: billingSource,
    signal: { message: '{"success":false,"code":"CE-011"}' },
    expected: reason("auth"),
  },
  {
    id: "billing-chinese-auth-failed",
    source: billingSource,
    signal: { message: "鉴权失败，请检查API Key" },
    expected: reason("auth"),
  },
  {
    // #48988
    id: "matches-zai-1113",
    source: matchesSource,
    signal: {
      provider: "zai",
      message: '{"code":1113,"message":"invalid api endpoint or credentials"}',
    },
    expected: reason("auth"),
  },
  {
    // #114784
    id: "matches-google-invalid-key",
    source: matchesSource,
    signal: {
      provider: "google",
      message:
        "Google Generative AI API error (400): API key not valid. Please pass a valid API key. [code=INVALID_ARGUMENT]",
    },
    expected: reason("auth"),
  },
  {
    id: "matches-google-api-key-invalid-code",
    source: matchesSource,
    signal: { provider: "google", message: '{"code":"API_KEY_INVALID"}' },
    expected: reason("auth"),
  },
  {
    id: "patterns-html-401",
    source: patternsSource,
    signal: {
      status: 401,
      message:
        "<!doctype html><html><head><title>401 Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>",
    },
    expected: reason("auth"),
  },
  {
    id: "patterns-html-403",
    source: patternsSource,
    signal: {
      status: 403,
      message:
        "<!doctype html><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>",
    },
    expected: reason("auth"),
  },
  {
    id: "structured-403-quota-without-hook",
    source: structuredSource,
    signal: {
      provider: "demo-provider",
      status: 403,
      code: "PROVIDER_QUOTA_EXHAUSTED",
      message: "Forbidden",
    },
    expected: reason("auth"),
  },
  {
    id: "structured-403-rate-without-hook",
    source: structuredSource,
    signal: {
      provider: "demo-provider",
      status: 403,
      code: "PROVIDER_RATE_LIMITED",
      message: "Forbidden",
    },
    expected: reason("auth"),
  },
  {
    id: "structured-message-prefix-403",
    source: structuredSource,
    signal: { provider: "demo-provider", message: "403 concurrency limit breached" },
    expected: reason("auth"),
  },
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
  {
    id: "billing-invalid-request-format",
    source: billingSource,
    signal: { message: "invalid request format" },
    expected: reason("format"),
  },
  {
    id: "billing-prefill-unsupported",
    source: billingSource,
    signal: {
      message:
        "This model does not support assistant message prefill. The conversation must end with a user message.",
    },
    expected: reason("format"),
  },
  {
    id: "billing-pattern-string",
    source: billingSource,
    signal: { message: "string should match pattern" },
    expected: reason("format"),
  },
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
  {
    id: "structured-invalid-request-raw",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.27.content.1: thinking blocks cannot be modified"}}',
    },
    expected: reason("format"),
  },
  {
    id: "structured-invalid-request-typed",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      errorType: "invalid_request_error",
      message: "thinking blocks cannot be modified",
    },
    expected: reason("format"),
  },
  {
    // #118615, #116967
    id: "structured-invalid-signature",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
    },
    expected: reason("format"),
  },
  {
    id: "structured-invalid-signature-carrier",
    source: structuredSource,
    signal: {
      provider: "anthropic",
      message:
        'Validation error: The model returned the following errors: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.1: Invalid `signature` in `thinking` block"}}',
    },
    expected: reason("format"),
  },
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
    expected: reason("rate_limit"),
  },
  {
    id: "retry-model-preview-not-found",
    source: retrySource,
    signal: { message: "model model-x-500-preview not found" },
    expected: null,
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
  {
    id: "billing-image-size",
    source: billingSource,
    signal: { message: "image exceeds 5 MB maximum" },
    expected: null,
  },
  {
    id: "billing-malformed-function-call",
    source: billingSource,
    signal: { message: "Unhandled stop reason: MALFORMED_FUNCTION_CALL" },
    expected: null,
  },
  {
    id: "billing-bare-400",
    source: billingSource,
    signal: { message: "400 status code (no body)" },
    expected: null,
  },
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
  {
    id: "structured-rate-limit-type-without-hook",
    source: structuredSource,
    signal: { provider: "anthropic", errorType: "rate_limit_error", message: "" },
    expected: null,
  },
  {
    id: "structured-api-error-type-without-hook",
    source: structuredSource,
    signal: { provider: "anthropic", errorType: "api_error", message: "" },
    expected: null,
  },
  {
    id: "structured-non-owner-server-code",
    source: structuredSource,
    signal: { provider: "google", code: "SERVER_ERROR", message: "" },
    expected: null,
  },
  {
    id: "structured-non-owner-insufficient-quota",
    source: structuredSource,
    signal: { provider: "anthropic", code: "INSUFFICIENT_QUOTA", message: "" },
    expected: null,
  },
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
    expected: null,
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
  {
    id: "structured-openai-internal-non-owner",
    source: structuredSource,
    signal: { provider: "openai", code: "INTERNAL", message: "" },
    expected: null,
  },
  {
    id: "structured-openai-deadline-non-owner",
    source: structuredSource,
    signal: { provider: "openai", code: "DEADLINE_EXCEEDED", message: "" },
    expected: null,
  },
  {
    id: "structured-anthropic-unavailable-non-owner",
    source: structuredSource,
    signal: { provider: "anthropic", code: "UNAVAILABLE", message: "" },
    expected: null,
  },
  {
    id: "structured-google-api-error-non-owner",
    source: structuredSource,
    signal: { provider: "google", code: "API_ERROR", message: "" },
    expected: null,
  },
  {
    id: "structured-google-rate-limit-error-non-owner",
    source: structuredSource,
    signal: { provider: "google", code: "RATE_LIMIT_ERROR", message: "" },
    expected: null,
  },
  {
    id: "structured-generic-sdk-type",
    source: structuredSource,
    signal: { provider: "demo-provider", message: "unclassified provider failure" },
    expected: null,
  },

  // Structured provider codes with hooks intentionally disabled for determinism.
  {
    id: "anthropic-rate-limit-error-type-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: { provider: "anthropic", errorType: "rate_limit_error", message: "" },
    expected: null,
  },
  {
    id: "anthropic-api-error-type-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: { provider: "anthropic", errorType: "api_error", message: "" },
    expected: null,
  },
  {
    id: "anthropic-rate-limit-code-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: { provider: "anthropic", code: "RATE_LIMIT_ERROR", message: "" },
    expected: null,
  },
  {
    id: "anthropic-api-error-code-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: { provider: "anthropic", code: "API_ERROR", message: "" },
    expected: null,
  },
  {
    id: "openai-server-code-core-fallback",
    source: "extensions/openai/openai-provider.test.ts",
    signal: { provider: "openai", code: "SERVER_ERROR", message: "" },
    expected: null,
  },
  {
    id: "openai-insufficient-quota-code-core-fallback",
    source: "extensions/openai/openai-provider.test.ts",
    signal: { provider: "openai", code: "INSUFFICIENT_QUOTA", message: "" },
    expected: null,
  },
  {
    id: "google-unavailable-code-core-fallback",
    source: "extensions/google/provider-hooks.test.ts",
    signal: { provider: "google", code: "UNAVAILABLE", message: "" },
    expected: null,
  },
  {
    id: "google-deadline-code-core-fallback",
    source: "extensions/google/provider-hooks.test.ts",
    signal: { provider: "google-vertex", code: "DEADLINE_EXCEEDED", message: "" },
    expected: null,
  },
  {
    id: "google-internal-code-core-fallback",
    source: "extensions/google/provider-hooks.test.ts",
    signal: { provider: "google-antigravity", code: "INTERNAL", message: "" },
    expected: null,
  },
  {
    id: "anthropic-claude-cli-rate-limit-type-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: { provider: "claude-cli", errorType: "rate_limit_error", message: "" },
    expected: null,
  },
  {
    id: "anthropic-claude-cli-api-error-type-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: { provider: "claude-cli", errorType: "api_error", message: "" },
    expected: null,
  },
  {
    id: "anthropic-rate-limit-type-api-code-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: {
      provider: "anthropic",
      errorType: "rate_limit_error",
      code: "API_ERROR",
      message: "",
    },
    expected: null,
  },
  {
    id: "anthropic-insufficient-quota-code-core-fallback",
    source: "extensions/anthropic/index.test.ts",
    signal: {
      provider: "anthropic",
      errorType: "UNKNOWN_ERROR",
      code: "INSUFFICIENT_QUOTA",
      message: "",
    },
    expected: null,
  },
  {
    id: "azure-openai-server-code-core-fallback",
    source: "extensions/openai/openai-provider.test.ts",
    signal: { provider: "azure-openai", code: "SERVER_ERROR", message: "" },
    expected: null,
  },
  {
    id: "azure-openai-insufficient-quota-code-core-fallback",
    source: "extensions/openai/openai-provider.test.ts",
    signal: { provider: "azure-openai", code: "INSUFFICIENT_QUOTA", message: "" },
    expected: null,
  },
  {
    id: "azure-openai-responses-server-code-core-fallback",
    source: "extensions/openai/openai-provider.test.ts",
    signal: { provider: "azure-openai-responses", code: "SERVER_ERROR", message: "" },
    expected: null,
  },
  {
    id: "azure-openai-responses-insufficient-quota-code-core-fallback",
    source: "extensions/openai/openai-provider.test.ts",
    signal: { provider: "azure-openai-responses", code: "INSUFFICIENT_QUOTA", message: "" },
    expected: null,
  },
  {
    id: "openai-api-error-code-core-fallback",
    source: "extensions/openai/openai-provider.test.ts",
    signal: { provider: "openai", code: "API_ERROR", message: "" },
    expected: null,
  },
  {
    id: "google-gemini-cli-unavailable-core-fallback",
    source: "extensions/google/provider-hooks.test.ts",
    signal: { provider: "google-gemini-cli", code: "UNAVAILABLE", message: "" },
    expected: null,
  },
  {
    id: "google-insufficient-quota-core-fallback",
    source: "extensions/google/provider-hooks.test.ts",
    signal: { provider: "google-vertex", code: "INSUFFICIENT_QUOTA", message: "" },
    expected: null,
  },
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
