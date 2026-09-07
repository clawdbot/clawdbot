import {
  legacyFailoverCorpusRows,
  matchesSource,
  patternsSource,
} from "./failover-classification.corpus.test-support.js";

// Distinct real inputs preserved from matcher-specific suites retired by refactor-02.
export const legacyProviderMatcherCases = legacyFailoverCorpusRows(
  "legacy-provider-matchers",
  matchesSource,
  [
    [
      1,
      "isAuthErrorMessage",
      '{"code": 1113, "message": "invalid api endpoint or credentials"}',
      "auth",
    ],
    [
      2,
      "isBillingErrorMessage",
      '{"code":1311,"message":"The model you requested is not available in your current plan","details":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}',
      "billing",
    ],
    [
      3,
      "isBillingErrorMessage",
      '{"error":{"code":"InvalidSubscription","message":"Your account does not have a valid coding plan subscription, or your subscription has expired.","details":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}',
      "billing",
    ],
    [
      4,
      [patternsSource, "classifyFailoverReason"],
      "401 <!doctype html><html><head><title>401 Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>",
      "auth",
    ],
    [
      5,
      [patternsSource, "classifyFailoverReason"],
      "403 <!doctype html><html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1></body></html>",
      "auth",
    ],
    [
      6,
      [patternsSource, "classifyFailoverReason"],
      "502 <!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><p>cloudflare-nginx</p></body></html>",
      "timeout",
    ],
    [
      7,
      [patternsSource, "classifyFailoverReason"],
      "503 <!doctype html><html><head><title>503</title></head><body><h1>Service Unavailable</h1><p>Please try again. Rate limit exceeded.</p></body></html>",
      "timeout",
    ],
    [8, "isAuthErrorMessage", "API key invalidation policy updated", null],
    [
      9,
      [patternsSource, "classifyProviderSpecificError"],
      "concurrency limit reached",
      "rate_limit",
    ],
    [
      10,
      [patternsSource, "classifyFailoverReason"],
      "Error: 401 <!doctype html><html><head><title>401 Unauthorized</title></head><body><h1>Unauthorized</h1></body></html>",
      "auth",
    ],
    [
      11,
      "classifyFailoverReason",
      'HTTP 429: 429 status code (exceeded limit)\n{"code":1305,"message":"The service may be temporarily overloaded, please try again later."}',
      "rate_limit",
    ],
    [12, [patternsSource, "matchesProviderContextOverflow"], "internal server error", "timeout"],
    [13, "isAuthErrorMessage", "invalid api key provided", "auth"],
    [14, "isAuthErrorMessage", "INVALID API KEYSTORE configuration", null],
    [
      15,
      "isTimeoutErrorMessage",
      "LLM request failed: connection refused by the provider endpoint.",
      null,
    ],
    [
      16,
      "isTimeoutErrorMessage",
      "LLM request failed: provider rejected the request schema or tool payload.",
      null,
    ],
    [17, "classifyFailoverReason", "llm request failed.", "timeout"],
    [18, "classifyFailoverReason", "LLM request failed.", "timeout"],
    [
      19,
      [patternsSource, "classifyProviderSpecificError"],
      "model_is_deactivated",
      "model_not_found",
    ],
    [
      20,
      [patternsSource, "matchesProviderContextOverflow"],
      "Permission denied for /root/oc-acp-write-should-fail.txt.",
      null,
    ],
    [21, "isServerErrorMessage", "provider failed (HTTP 500): upstream apiKey is empty", "timeout"],
    [
      22,
      "classifyFailoverReason",
      'Requested agent harness "codex" does not support openrouter/gpt-5.4 (provider is not one of: codex, openai).',
      "format",
    ],
    [23, [patternsSource, "classifyProviderSpecificError"], "some random error", null],
    [24, "isServerErrorMessage", "status: internal server error", "timeout"],
  ],
);
