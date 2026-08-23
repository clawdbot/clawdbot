import {
  reason,
  type FailoverClassificationCorpusRow,
} from "./failover-classification.corpus.test-support.js";

// Distinct real inputs preserved from matcher-specific suites retired by refactor-02.
export const legacyProviderMatcherCases = [
  {
    id: "legacy-provider-matchers-001",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isAuthErrorMessage",
    signal: { message: '{"code": 1113, "message": "invalid api endpoint or credentials"}' },
    expected: reason("auth"),
  },
  {
    id: "legacy-provider-matchers-002",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isBillingErrorMessage",
    signal: {
      message:
        '{"code":1311,"message":"The model you requested is not available in your current plan","details":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}',
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-provider-matchers-003",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isBillingErrorMessage",
    signal: {
      message:
        '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid coding plan subscription, or your subscription has expired.","details":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}',
    },
    expected: reason("billing"),
  },
  {
    id: "legacy-provider-matchers-004",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyFailoverReason",
    signal: {
      message:
        "401 <!doctype html><html><head><title>401 Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>",
    },
    expected: reason("auth"),
  },
  {
    id: "legacy-provider-matchers-005",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyFailoverReason",
    signal: {
      message:
        "403 <!doctype html><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>",
    },
    expected: reason("auth"),
  },
  {
    id: "legacy-provider-matchers-006",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyFailoverReason",
    signal: {
      message:
        "502 <!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>cloudflare-nginx</p></body></html>",
    },
    expected: reason("timeout"),
  },
  {
    id: "legacy-provider-matchers-007",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyFailoverReason",
    signal: {
      message:
        "503 <!doctype html><html><head><title>503</title></head><body><h1>Service Unavailable</h1><p>Please try again. Rate limit exceeded.</p></body></html>",
    },
    expected: reason("timeout"),
  },
  {
    id: "legacy-provider-matchers-008",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isAuthErrorMessage",
    signal: { message: "API key invalidation policy updated" },
    expected: null,
  },
  {
    id: "legacy-provider-matchers-009",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyProviderSpecificError",
    signal: { message: "concurrency limit reached" },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-provider-matchers-010",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyFailoverReason",
    signal: {
      message:
        "Error: 401 <!doctype html><html><head><title>401 Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>",
    },
    expected: reason("auth"),
  },
  {
    id: "legacy-provider-matchers-011",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#classifyFailoverReason",
    signal: {
      message:
        'HTTP 429: 429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}',
    },
    expected: reason("rate_limit"),
  },
  {
    id: "legacy-provider-matchers-012",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#matchesProviderContextOverflow",
    signal: { message: "internal server error" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-provider-matchers-013",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isAuthErrorMessage",
    signal: { message: "invalid api key provided" },
    expected: reason("auth"),
  },
  {
    id: "legacy-provider-matchers-014",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isAuthErrorMessage",
    signal: { message: "INVALID API KEYSTORE configuration" },
    expected: null,
  },
  {
    id: "legacy-provider-matchers-015",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isTimeoutErrorMessage",
    signal: { message: "LLM request failed: connection refused by the provider endpoint." },
    expected: null,
  },
  {
    id: "legacy-provider-matchers-016",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isTimeoutErrorMessage",
    signal: {
      message: "LLM request failed: provider rejected the request schema or tool payload.",
    },
    expected: null,
  },
  {
    id: "legacy-provider-matchers-017",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#classifyFailoverReason",
    signal: { message: "llm request failed." },
    expected: reason("timeout"),
  },
  {
    id: "legacy-provider-matchers-018",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#classifyFailoverReason",
    signal: { message: "LLM request failed." },
    expected: reason("timeout"),
  },
  {
    id: "legacy-provider-matchers-019",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyProviderSpecificError",
    signal: { message: "model_is_deactivated" },
    expected: reason("model_not_found"),
  },
  {
    id: "legacy-provider-matchers-020",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#matchesProviderContextOverflow",
    signal: { message: "Permission denied for /root/oc-acp-write-should-fail.txt." },
    expected: null,
  },
  {
    id: "legacy-provider-matchers-021",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isServerErrorMessage",
    signal: { message: "provider failed (HTTP 500): upstream apiKey is empty" },
    expected: reason("timeout"),
  },
  {
    id: "legacy-provider-matchers-022",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#classifyFailoverReason",
    signal: {
      message:
        'Requested agent harness "codex" does not support openrouter/gpt-5.4 (provider is not one of: codex, openai).',
    },
    expected: reason("format"),
  },
  {
    id: "legacy-provider-matchers-023",
    source:
      "src/agents/embedded-agent-helpers/provider-error-patterns.test.ts#classifyProviderSpecificError",
    signal: { message: "some random error" },
    expected: null,
  },
  {
    id: "legacy-provider-matchers-024",
    source: "src/agents/embedded-agent-helpers/failover-matches.test.ts#isServerErrorMessage",
    signal: { message: "status: internal server error" },
    expected: reason("timeout"),
  },
] satisfies readonly FailoverClassificationCorpusRow[];
