import {
  contextOverflow,
  reason,
  type FailoverClassificationCorpusRow,
} from "./failover-classification.corpus.test-support.js";

// Distinct real inputs preserved from matcher-specific suites retired by refactor-02.
export const legacyBillingACases = [
  {
    id: "legacy-billing-a-001",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "  An unknown error occurred  " },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-002",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "  Request failed  " },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-003",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "  stream_read_error  " },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-004",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "  terminated  " },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-005",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: {
      message:
        '{"error":{"code":402,"message":"payment required","details":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}',
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-006",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message: '{"type":"error","error":{"type":"api_error","message":"invalid input format"}}',
    },
    expected: null,
  },
  {
    id: "legacy-billing-a-007",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        '{"type":"error","error":{"type":"api_error","message":"messages.1.content.1.tool_use.id should match pattern"}}',
    },
    expected: reason("format"),
  },
  {
    id: "legacy-billing-a-008",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        '{"type":"error","error":{"type":"api_error","message":"Request size exceeds model context window"}}',
    },
    expected: contextOverflow,
  },
  {
    id: "legacy-billing-a-009",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isContextOverflowError,isLikelyContextOverflowError",
    signal: {
      message:
        '{"type":"error","error":{"type":"invalid_request_error","message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}',
    },
    expected: reason("format"),
  },
  {
    id: "legacy-billing-a-010",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage,classifyFailoverReason",
    signal: { message: "402 items found in the database" },
    expected: null,
  },
  {
    id: "legacy-billing-a-011",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        '402 Payment Required Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request."},"sequence_number":2}',
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-012",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage,isLikelyContextOverflowError",
    signal: { message: "402 Payment Required: request token limit exceeded for this billing plan" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-013",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "402 records processed" },
    expected: null,
  },
  {
    id: "legacy-billing-a-014",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "402 room is available" },
    expected: null,
  },
  {
    id: "legacy-billing-a-015",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "404 status code (no body)" },
    expected: reason("model_not_found"),
  },
  {
    id: "legacy-billing-a-016",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "410" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-017",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "410 conversation expired" },
    expected: reason("session_expired"),
  },
  {
    id: "legacy-billing-a-018",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "410 Gone" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-019",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "410: No body" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-020",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "422 status code (no body)" },
    expected: null,
  },
  {
    id: "legacy-billing-a-021",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      provider: "openai",
      message:
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"You\\u0027ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM."}}',
    },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-022",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isFailoverErrorMessage",
    signal: { message: "429 rate limit exceeded" },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-023",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "access denied" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-a-024",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "all credentials for model x are cooling down" },
    expected: null,
  },
  {
    id: "legacy-billing-a-025",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "an unknown error occurred" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-026",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "AN UNKNOWN ERROR OCCURRED" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-027",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "An unknown error occurred." },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-028",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "api key deactivated" },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-a-029",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "api key revoked" },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-a-030",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "api_key_deleted" },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-a-031",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "API_KEY_REVOKED" },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-a-032",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage,isContextOverflowError",
    signal: { message: "authentication failed" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-a-033",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "bad request" },
    expected: null,
  },
  {
    id: "legacy-billing-a-034",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthErrorMessage",
    signal: { message: "billing issue detected" },
    expected: null,
  },
  {
    id: "legacy-billing-a-035",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "Book a 402 room" },
    expected: null,
  },
  {
    id: "legacy-billing-a-036",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isLikelyContextOverflowError,classifyFailoverReason",
    signal: { message: "Context window exceeded: too many tokens per request." },
    expected: null,
  },
  {
    id: "legacy-billing-a-037",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isLikelyContextOverflowError",
    signal: { message: "Context window too small: minimum is 1000 tokens" },
    expected: null,
  },
  {
    id: "legacy-billing-a-038",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "conversation must end with a user message" },
    expected: reason("format"),
  },
  {
    id: "legacy-billing-a-039",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "deactivated workspace" },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-a-040",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "deactivated_workspace" },
    expected: reason("auth_permanent"),
  },
  {
    id: "legacy-billing-a-041",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "Error code 403 was returned, not 402-related" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-a-042",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'ERROR provider=google model=gemini-3.1-flash-lite-preview: got status: INTERNAL, details: {"code":500,"status":"INTERNAL"}',
    },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-043",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "Error: HTTP 422: No response body" },
    expected: null,
  },
  {
    id: "legacy-billing-a-044",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isLikelyContextOverflowError",
    signal: { message: "exceeded your current quota" },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-045",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: { message: "finish_reason: error" },
    expected: reason("server_error"),
  },
  {
    id: "legacy-billing-a-046",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "Fixed issue CHE-402 in the latest release" },
    expected: null,
  },
  {
    id: "legacy-billing-a-047",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isAuthPermanentErrorMessage",
    signal: { message: "forbidden" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-a-048",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "got a 402 from the API" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-049",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isTimeoutErrorMessage,classifyFailoverReason,isFailoverErrorMessage",
    signal: {
      message:
        'got status: INTERNAL. {"error":{"code":400,"message":"Request malformed","status":"INTERNAL"}}',
    },
    expected: null,
  },
  {
    id: "legacy-billing-a-050",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'got status: INTERNAL. {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
    },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-051",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        'HTTP 400: {"type":"error","error":{"type":"insufficient_quota","message":"Your account has insufficient quota balance to run this request."}}',
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-052",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 400: INVALID_ARGUMENT: input exceeds the maximum number of tokens" },
    expected: contextOverflow,
  },
  {
    id: "legacy-billing-a-053",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 400: No body" },
    expected: null,
  },
  {
    id: "legacy-billing-a-054",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 400: ThrottlingException: Too many concurrent requests" },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-055",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message: 'HTTP 401: {"type":"error","error":{"type":"server_error","code":"server_error"}}',
    },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-a-057",
    source: "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#isBillingErrorMessage",
    signal: { message: "http 402" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-058",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-059",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message: 'HTTP 402: {"type":"error","error":{"type":"server_error","code":"server_error"}}',
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-060",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: 402: rate limit exceeded" },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-061",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: Daily limit reached, resets tomorrow." },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-062",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: Insufficient credits. Organization limit reached." },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-063",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message: "HTTP 402: Monthly spend limit reached. Please visit your billing settings.",
    },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-064",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: Payment required" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-065",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: rate limit exceeded" },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-066",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        "HTTP 402: The account associated with this API key has reached its maximum allowed monthly spending limit.",
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-067",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: Weekly usage limit exhausted." },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-billing-a-068",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message:
        "HTTP 402: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx insufficient credits. Monthly spend limit reached.",
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-069",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: Your credit balance is too low. Monthly limit exceeded." },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-070",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 402: Your usage limit has been reached. Please upgrade your plan." },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-072",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 404: insufficient credits" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-073",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 404: invalid_api_key" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-a-074",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 404: No body" },
    expected: reason("model_not_found"),
  },
  {
    id: "legacy-billing-a-075",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 404: session not found" },
    expected: reason("session_expired"),
  },
  {
    id: "legacy-billing-a-076",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 410" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-077",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 410: conversation expired" },
    expected: reason("session_expired"),
  },
  {
    id: "legacy-billing-a-078",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 410: insufficient credits" },
    expected: reason("billing"),
  },
  {
    id: "legacy-billing-a-079",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 410: invalid_api_key" },
    expected: reason("auth"),
  },
  {
    id: "legacy-billing-a-080",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 410: No body" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-081",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 410: No body response" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-billing-a-082",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: {
      message: 'HTTP 422: {"type":"error","error":{"type":"server_error","code":"server_error"}}',
    },
    expected: reason("format"),
  },
  {
    id: "legacy-billing-a-083",
    source:
      "src/agents/embedded-agent-helpers.isbillingerrormessage.test.ts#classifyFailoverReason",
    signal: { message: "HTTP 422: check open ai req parameter error" },
    expected: reason("format"),
  },
] satisfies readonly FailoverClassificationCorpusRow[];
