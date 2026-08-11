import {
  contextOverflow,
  reason,
  type FailoverClassificationCorpusRow,
} from "./failover-classification.corpus.test-support.js";

// Distinct real inputs preserved from matcher-specific suites retired by refactor-02.
export const legacyBillingBCases = [
  {
    id: "legacy-billing-b-001",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 422: insufficient credits" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-002",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 422: No body" },
    expected: null,
  },
  {
    id: "legacy-billing-b-003",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 422: No response body" },
    expected: null,
  },
  {
    id: "legacy-billing-b-004",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 422: Unprocessable Entity" },
    expected: reason("format"),
  },
  {
    id: "legacy-billing-b-005",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 499" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-006",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'HTTP 499: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    },
    expected: reason("overloaded"),
  },
  {
    id: "legacy-billing-b-007",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 499: 499 Client Closed Request" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-008",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 500" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-009",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'HTTP 500: Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
    },
    expected: reason("server_error"),
  },
  {
    id: "legacy-billing-b-010",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'HTTP 502: Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
    },
    expected: reason("server_error"),
  },
  {
    id: "legacy-billing-b-011",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'HTTP 504: Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
    },
    expected: reason("server_error"),
  },
  {
    id: "legacy-billing-b-012",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage,isLikelyContextOverflowError",
    signal: { message: "insufficient credits: request size exceeds your current plan limits" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-013",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage,isFailoverErrorMessage,classifyFailoverReason; src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#matchesProviderContextOverflow",
    signal: { message: "invalid api key" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-014",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "invalid token" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-015",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "ISSUE-402 has been resolved" },
    expected: null,
  },
  {
    id: "legacy-billing-b-016",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "key has been revoked" },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-b-018",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "Let's investigate the context overflow bug" },
    expected: null,
  },
  {
    id: "legacy-billing-b-019",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "LLM request failed with an unknown error." },
    expected: null,
  },
  {
    id: "legacy-billing-b-020",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "LLM request rejected: does not support assistant message prefill" },
    expected: reason("format"),
  },
  {
    id: "legacy-billing-b-021",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        "messages.84.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels",
    },
    expected: null,
  },
  {
    id: "legacy-billing-b-022",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isLikelyContextOverflowError",
    signal: { message: "Model context window too small (minimum is 128k tokens)" },
    expected: null,
  },
  {
    id: "legacy-billing-b-023",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "model not found" },
    expected: reason("model_not_found"),
  },
  {
    id: "legacy-billing-b-024",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "model_context_window_exceeded" },
    expected: contextOverflow,
  },
  {
    id: "legacy-billing-b-025",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "no api key found" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-026",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'No API key found for provider "openai". Auth store: /tmp/openclaw-agent-abc/auth-profiles.json (agentDir: /tmp/openclaw-agent-abc).',
    },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-027",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "no credentials found" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-028",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      provider: "openai",
      message:
        "OAuth token refresh failed for openai: file lock timeout for /tmp/agent/auth-profiles.json. Please try again or re-authenticate.",
    },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-029",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      provider: "openai",
      message:
        "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
    },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-b-030",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "Payment Required" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-031",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "port 402 is open" },
    expected: null,
  },
  {
    id: "legacy-billing-b-032",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "processed 402 records" },
    expected: null,
  },
  {
    id: "legacy-billing-b-033",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "Prompt is too long" },
    expected: contextOverflow,
  },
  {
    id: "legacy-billing-b-034",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage; src/agents/embedded-agent-helpers/failover-matches.test.ts#isServerErrorMessage",
    signal: { message: "Proxy notice: Status: Internal Server Error" },
    expected: null,
  },
  {
    id: "legacy-billing-b-035",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "Proxy notice: Status: Internal Server Error; code:500" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-036",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "Proxy notice: Status: Internal Server Error; upstream connect error" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-037",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: {
      message:
        "Quarterly report summary: subsystem A returned 402 records after retry. This is an analytics count, not an HTTP/API billing failure. Notes: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-038",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "reason: abort" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-039",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "reason: network_error" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-040",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "received a 402 response" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-041",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "request failed" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-042",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "request size exceeds model context window" },
    expected: contextOverflow,
  },
  {
    id: "legacy-billing-b-043",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "request size exceeds upload limit" },
    expected: null,
  },
  {
    id: "legacy-billing-b-044",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isFailoverErrorMessage",
    signal: { message: "request timed out" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-045",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "Room 402 is available" },
    expected: null,
  },
  {
    id: "legacy-billing-b-046",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "See ticket #402 for details" },
    expected: null,
  },
  {
    id: "legacy-billing-b-047",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "Something is causing context overflow messages" },
    expected: null,
  },
  {
    id: "legacy-billing-b-048",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "status=402 payment required" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-049",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "stop reason: abort" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-050",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "stop reason: error" },
    expected: reason("server_error"),
  },
  {
    id: "legacy-billing-b-051",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "stop reason: MALFORMED_RESPONSE" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-052",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "stop reason: network_error" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-053",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "stream aborted" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-054",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "stream closed" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-055",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: {
      message:
        "Sure! Here's how to set up billing for your SaaS application.\n\n## Payment Integration\n\nFirst, you'll need to configure your payment gateway. Most providers offer a dashboard where you can manage credits, view invoices, and upgrade your plan. The billing page typically shows your current balance and payment history.\n\n## Managing Credits\n\nUsers can purchase credits through the billing portal. When their credit balance runs low, send them a notification to upgrade their plan or add more credits. You should also handle insufficient balance cases gracefully.\n\n## Subscription Plans\n\nOffer multiple plan tiers with different features. Allow users to upgrade or downgrade their plan at any time. Make sure the billing cycle is clear.\n\nLet me know if you need more details on any of these topics!",
    },
    expected: null,
  },
  {
    id: "legacy-billing-b-056",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "Terminated" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-057",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "The building at 402 Main Street" },
    expected: null,
  },
  {
    id: "legacy-billing-b-058",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage,classifyFailoverReason",
    signal: {
      message: "The evidence is insufficient to reconcile the final balance after compaction.",
    },
    expected: null,
  },
  {
    id: "legacy-billing-b-059",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "The mystery context overflow errors are strange" },
    expected: null,
  },
  {
    id: "legacy-billing-b-060",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "the operation was aborted" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-061",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "The user terminated the session manually." },
    expected: null,
  },
  {
    id: "legacy-billing-b-062",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "There is a 402 near me" },
    expected: null,
  },
  {
    id: "legacy-billing-b-063",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isLikelyContextOverflowError",
    signal: { message: "This endpoint requires reasoning" },
    expected: null,
  },
  {
    id: "legacy-billing-b-064",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "This model requires reasoning to be enabled" },
    expected: null,
  },
  {
    id: "legacy-billing-b-065",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "This operation was aborted" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-066",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "token has expired" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-067",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "unauthorized" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-b-068",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "UND_ERR_SOCKET" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-069",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "Unhandled stop reason: context_window_exceeded" },
    expected: contextOverflow,
  },
  {
    id: "legacy-billing-b-070",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "Unhandled stop reason: error" },
    expected: reason("server_error"),
  },
  {
    id: "legacy-billing-b-071",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "Unhandled stop reason: malformed_response" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-b-072",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "Unknown error (no error details in response)" },
    expected: reason("no_error_details"),
  },
  {
    id: "legacy-billing-b-073",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "Use a 402 stainless bolt" },
    expected: null,
  },
  {
    id: "legacy-billing-b-074",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "user reported that an unknown error occurred during sync" },
    expected: null,
  },
  {
    id: "legacy-billing-b-075",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "We're debugging context overflow issues" },
    expected: null,
  },
  {
    id: "legacy-billing-b-076",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      provider: "openai",
      message:
        "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM.",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-b-077",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      provider: "openai",
      message:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits, try again later.",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-b-078",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      provider: "openai",
      message:
        "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
    },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-b-079",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      provider: "openai",
      message:
        "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-b-080",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isFailoverErrorMessage",
    signal: { message: "Your credit balance is too low" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-081",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage,isLikelyContextOverflowError",
    signal: { message: "Your credit balance is too low. Maximum request token limit exceeded." },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-b-082",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError",
    signal: { message: "上下文过长" },
    expected: contextOverflow,
  },
] satisfies readonly FailoverClassificationCorpusRow[];
