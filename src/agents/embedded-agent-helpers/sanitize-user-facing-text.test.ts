// Regression coverage for sanitizeUserFacingText error-context rewrites.
import { describe, expect, it } from "vitest";
import { sanitizeUserFacingText } from "./sanitize-user-facing-text.js";

describe("sanitizeUserFacingText (error context)", () => {
  describe("classifies leading error line then appends safe follow-up prose (#96007)", () => {
    it("classifies timeout error line and appends recommendations", () => {
      const text = [
        "Error: connection timed out",
        "",
        "Recommendation: try restarting the service.",
        "Next steps:",
        "1. Check logs",
        "2. Retry",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      // Leading line classified as timeout
      expect(result).toContain("LLM request timed out");
      // Safe follow-up prose appended
      expect(result).toContain("Recommendation");
      expect(result).toContain("Check logs");
      expect(result).toContain("Retry");
    });

    it("classifies transport error line and appends safe multi-paragraph content", () => {
      const text = [
        "Error: fetch failed. SocketError: other side closed",
        "",
        "Recommendation: review the findings below and restart the service.",
        "• Item A is healthy",
        "• Item B is healthy",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      // Leading line classified as transport error
      expect(result).toContain("LLM request failed");
      // Safe prose appended
      expect(result).toContain("Item A is healthy");
      expect(result).toContain("Recommendation");
    });

    it("classifies leading line and appends guidance after an API Error prefix", () => {
      const text = [
        "API Error 500: internal server error",
        "",
        "Suggested fix: restart the worker and verify the configuration.",
        "1. Check logs",
        "2. Retry",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("Suggested fix");
      expect(result).toContain("Check logs");
    });
  });

  describe("strips stack traces from multiline error suffixes", () => {
    it("returns only the classified error when suffix is a stack trace", () => {
      const text = [
        "Error: ECONNREFUSED",
        "    at Server.onError (server.ts:42:8)",
        "    at emitError (events.js:153:12)",
        "    at processTicksAndRejections (internal/process/task_queues.js:95:5)",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      // Leading line classified as transport error
      expect(result).toContain("connection refused");
      // Stack trace MUST NOT leak
      expect(result).not.toContain("server.ts");
      expect(result).not.toContain("events.js");
      expect(result).not.toContain("processTicksAndRejections");
    });

    it("returns only the classified error when suffix is a JSON payload body", () => {
      const text = [
        "Error: fetch failed",
        '{"error":{"type":"server_error","message":"internal"}}',
        '{"request_id":"req_abc123"}',
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      // Leading line classified as transport error
      expect(result).toContain("LLM request failed");
      // JSON body MUST NOT leak
      expect(result).not.toContain('"server_error"');
      expect(result).not.toContain('"req_abc123"');
    });

    it("returns only the classified error when suffix is an HTML error page", () => {
      const text = [
        "Error: gateway error",
        "<!doctype html>",
        "<html><body>502 Bad Gateway</body></html>",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      // HTML body MUST NOT leak
      expect(result).not.toContain("<!doctype html>");
      expect(result).not.toContain("502 Bad Gateway");
    });

    it("returns only the classified error when suffix is an HTML page without doctype", () => {
      const text = [
        "Error: gateway error",
        '<html lang="en">',
        "<head><title>502 Bad Gateway</title></head>",
        "<body>Server Error</body>",
        "</html>",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      // Raw <html> provider page MUST NOT leak
      expect(result).not.toContain("<html");
      expect(result).not.toContain("502 Bad Gateway");
      expect(result).not.toContain("Server Error");
    });

    it("rejects suffix when a single stack-frame line is present", () => {
      // A single stack-frame line (file:///tmp/app.mjs:10:3) is enough to
      // classify the suffix as unsafe.
      const text = [
        "Error: something went wrong",
        "    at loadApp (file:///tmp/app.mjs:10:3)",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("something went wrong");
      expect(result).not.toContain("file://");
      expect(result).not.toContain("app.mjs");
    });

    it("rejects mixed prose and stack-frame suffix", () => {
      // Safe prose mixed with a stack-frame line: the whole suffix is rejected
      // because a single stack frame is enough to classify it as unsafe.
      const text = [
        "Error: something went wrong",
        "",
        "Please check the following:",
        "    at loadApp (file:///tmp/app.mjs:10:3)",
        "Recommendation: try restarting the service.",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("something went wrong");
      // Stack frame MUST NOT leak
      expect(result).not.toContain("file://");
      expect(result).not.toContain("app.mjs");
      // Prose mixed with stack frames is rejected
      expect(result).not.toContain("Please check");
      expect(result).not.toContain("Recommendation");
    });

    it("appends safe prose after a classified leading line even when one line looks suspicious", () => {
      // A single "at …" line that does not match the stack-frame pattern
      // (no file:line:line suffix) still blocks the whole suffix under the
      // strict allow-list, because it is not a bullet / numbered list /
      // guidance heading. Verify that a suffix containing a guidance
      // heading followed by a numbered list survives, while the suspicious
      // free-form "at ..." line rejects an alternate suffix.
      const safeText = [
        "Error: Connection refused",
        "",
        "Recommendation: verify the proxy settings.",
        "1. Check the network proxy port",
      ].join("\n");
      const safeResult = sanitizeUserFacingText(safeText, { errorContext: true });
      expect(safeResult).toContain("LLM request failed");
      expect(safeResult).toContain("Recommendation");
      expect(safeResult).toContain("proxy port");

      const unsafeText = [
        "Error: Connection refused",
        "",
        "Please check:",
        "  at the network proxy settings first.",
        "1. Verify the proxy port",
      ].join("\n");
      const unsafeResult = sanitizeUserFacingText(unsafeText, { errorContext: true });
      expect(unsafeResult).toContain("LLM request failed");
      // Free-form "Please check:" is not a guidance heading (not in safe
      // labels), and the "at ..." line is not a bullet, so the whole
      // suffix is rejected.
      expect(unsafeResult).not.toContain("Please check");
    });

    it("strips node:internal stack frames", () => {
      const text = [
        "Error: ECONNREFUSED",
        "    at Server.onError (server.ts:42:8)",
        "    at runScript (node:internal/vm:219:10)",
        "    at runInContext (node:internal/vm:342:7)",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("connection refused");
      expect(result).not.toContain("node:internal");
      expect(result).not.toContain("server.ts");
    });

    it("strips file:// protocol stack frames", () => {
      const text = [
        "Error: something went wrong",
        "    at loadApp (file:///tmp/app.mjs:10:3)",
        "    at bootstrap (file:///tmp/bootstrap.mjs:42:5)",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("something went wrong");
      expect(result).not.toContain("file://");
      expect(result).not.toContain("app.mjs");
    });

    it("strips Windows drive-letter stack frames", () => {
      const text = [
        "Error: ECONNREFUSED",
        "    at App.run (C:\\Users\\Ada\\app.ts:12:5)",
        "    at Server.start (D:\\project\\server.ts:42:8)",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("connection refused");
      expect(result).not.toContain("app.ts");
      expect(result).not.toContain("server.ts");
    });

    it("strips async V8 stack frames", () => {
      const text = [
        "Error: something went wrong",
        "    at async loadApp (file:///tmp/app.mjs:10:3)",
        "    at async ModuleJob.run (node:internal/modules/esm/module_job:343:25)",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("something went wrong");
      expect(result).not.toContain("file://");
      expect(result).not.toContain("node:internal");
      expect(result).not.toContain("app.mjs");
    });

    it("strips a single async stack-frame line", () => {
      // Single async frame is enough to classify the suffix as unsafe.
      const text = [
        "Error: something went wrong",
        "    at async loadApp (file:///tmp/app.mjs:10:3)",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("something went wrong");
      expect(result).not.toContain("file://");
      expect(result).not.toContain("app.mjs");
    });

    it("rejects suffix when it contains an auth header", () => {
      const text = ["Error: fetch failed", "Authorization: Bearer sk-abc123"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("Bearer");
      expect(result).not.toContain("sk-abc123");
    });

    it("rejects suffix when it contains an x-api-key header", () => {
      const text = ["Error: fetch failed", "x-api-key: sk-proj-abc123xyz"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("x-api-key");
      expect(result).not.toContain("sk-proj");
    });

    it.each<[url: string, host: string]>([
      ["https://api.openai.com/v1/chat/completions", "api.openai.com"],
      [
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        "generativelanguage.googleapis.com",
      ],
    ])("rejects suffix when it contains a provider API endpoint URL (%s)", (url, host) => {
      const text = ["Error: fetch failed", `POST ${url}`].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain(host);
    });

    it("rejects suffix when it contains a request ID line", () => {
      const text = ["Error: fetch failed", "request_id: req_abc123"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("req_abc123");
    });

    it("rejects suffix when it contains a trace ID line", () => {
      const text = ["Error: fetch failed", "trace_id: tr_xyz789"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("tr_xyz789");
    });

    it("rejects suffix when it contains an api-key header", () => {
      const text = ["Error: fetch failed", "api-key: sk-live-abc123xyz"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("api-key");
      expect(result).not.toContain("sk-live");
    });

    it("rejects suffix when it contains a set-cookie header", () => {
      const text = ["Error: fetch failed", "set-cookie: session=abc123def456"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("set-cookie");
      expect(result).not.toContain("session=");
    });

    it("rejects suffix when it contains a CapitalCase Set-Cookie header", () => {
      const text = ["Error: fetch failed", "Set-Cookie: session=abc123def456"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("Set-Cookie");
      expect(result).not.toContain("session=");
    });

    it("rejects suffix when it contains an x-request-id header", () => {
      const text = ["Error: fetch failed", "x-request-id: req_abc123def"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("x-request-id");
      expect(result).not.toContain("req_abc123def");
    });

    it("rejects suffix when it contains a title-case Request ID header", () => {
      const text = ["Error: fetch failed", "Request ID: req_abc123"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("Request ID");
      expect(result).not.toContain("req_abc123");
    });

    it("rejects suffix when it contains a lower-case space-separated request id header", () => {
      const text = ["Error: fetch failed", "request id: req_abc123"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("request id");
      expect(result).not.toContain("req_abc123");
    });

    it("rejects suffix when it contains a title-case Correlation ID header", () => {
      const text = ["Error: fetch failed", "Correlation ID: abc-def-456"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("Correlation ID");
      expect(result).not.toContain("abc-def-456");
    });

    it("rejects suffix when it contains a title-case Trace ID header", () => {
      const text = ["Error: fetch failed", "Trace ID: tr_xyz789"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("Trace ID");
      expect(result).not.toContain("tr_xyz789");
    });

    it("rejects suffix when it contains a CapitalCase X-Request-Id header", () => {
      const text = ["Error: fetch failed", "X-Request-Id: req_abc123def"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("X-Request-Id");
      expect(result).not.toContain("req_abc123def");
    });

    it("rejects suffix when it contains a Cookie header", () => {
      const text = ["Error: fetch failed", "Cookie: session=abc123def456"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("Cookie");
      expect(result).not.toContain("session=");
    });

    it("rejects suffix when it contains a bearer token line", () => {
      const text = ["Error: fetch failed", "Bearer sk-abc123def456"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain("Bearer");
      expect(result).not.toContain("sk-abc");
    });

    // Credential-bearing labels — label contains a credential-class word
    // (`secret`/`token`/`password`/`key`/`credential`/`bearer`).  Covers
    // single-word (`Secret:`, `Token:`), multi-word (`Access Token:`,
    // `Client Secret:`, `Personal Access Token:`), and lowercase (`secret:`)
    // variants.  These share the "CapitalCase + colon + value" form with safe
    // guidance labels (`Recommendation: try...`) so they must be rejected
    // before the natural-prose allow-list gate.  See ClawSweeper P1 findings
    // on PR #96107 (reviews 2026-07-02 and 2026-07-03).
    it.each<[label: string, value: string, valueSnippet: string]>([
      ["Secret", "sk-abc123def456", "sk-abc"],
      ["Token", "abc-def-456", "abc-def"],
      ["Password", "hunter2", "hunter2"],
      ["Key", "sk-abc123def456", "sk-abc"],
      ["key", "sk-abc123def456", "sk-abc"],
      ["API Key", "sk-proj-abc123xyz", "sk-proj"],
      ["Access Key", "AKIAIOSFODNN7EXAMPLE", "AKIA"],
      ["Private Key", "-----BEGIN PRIVATE KEY-----", "BEGIN PRIVATE"],
      ["Credential", "abc123xyz", "abc123"],
      ["secret", "sk-abc123def456", "sk-abc"],
      ["Access Token", "abc-def-456", "abc-def"],
      ["Refresh Token", "rrf-789-012", "rrf-789"],
      ["Client Secret", "csec-xyz-999", "csec"],
      ["Personal Access Token", "pat_abc123", "pat_abc"],
      ["API Token", "apt-xyz-001", "apt-xyz"],
      ["Bearer Token", "abc-def-456", "abc-def"],
    ])("rejects suffix when it contains a %s label", (label, value, valueSnippet) => {
      const text = ["Error: fetch failed", `${label}: ${value}`].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).not.toContain(label);
      expect(result).not.toContain(valueSnippet);
    });

    // Inline credential prose — natural-sentence suffixes that carry
    // auth/credential values without matching the label-shaped guards above.
    // The natural-sentence allow-list must reject these before they pass
    // through.  See ClawSweeper P1 late finding on PR #96107 (review
    // 2026-07-06) and follow-up (review 2026-07-07): "Authorization
    // header: Bearer ...", "The bearer token is ...", "The secret key
    // is ...", and "The password was ..." must all be rejected.
    it.each<[label: string, line: string, snippets: string[]]>([
      [
        "Authorization header inline",
        "Authorization header: Bearer sk-abc123",
        ["Authorization header", "Bearer", "sk-abc123"],
      ],
      [
        "bearer token inline sentence",
        "The bearer token is sk-abc123def456",
        ["bearer token", "sk-abc123def456"],
      ],
      [
        "api key inline sentence",
        "The API key used was sk-proj-abc123xyz",
        ["API key", "sk-proj-abc123xyz"],
      ],
      [
        "secret key inline sentence",
        "The secret key is sk-abc123def456",
        ["secret key", "sk-abc123def456"],
      ],
      ["password inline sentence", "The password was hunter2abc3", ["password", "hunter2abc3"]],
      [
        "credential inline sentence",
        "The credential is abc123def456",
        ["credential", "abc123def456"],
      ],
      [
        "private key inline sentence",
        "The private key is sk-proj-abc123xyz",
        ["private key", "sk-proj-abc123xyz"],
      ],
      // Alphabetic-only credential values (no digit) — bot P1 finding 2026-07-10.
      [
        "password alphabetic-only inline sentence",
        "The password was correcthorsebattery",
        ["password", "correcthorsebattery"],
      ],
      [
        "secret alphabetic-only inline sentence",
        "The secret is correcthorsebatterystaple",
        ["secret", "correcthorsebatterystaple"],
      ],
      [
        "credential alphabetic-only inline sentence",
        "The credential is CorrectHorseBattery",
        ["credential", "CorrectHorseBattery"],
      ],
      [
        "private key alphabetic-only inline sentence",
        "The private key is correcthorsebatterystaple",
        ["private key", "correcthorsebatterystaple"],
      ],
    ])("rejects suffix when it contains inline credential prose (%s)", (_label, line, snippets) => {
      const text = ["Error: fetch failed", line].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      for (const snippet of snippets) {
        expect(result).not.toContain(snippet);
      }
    });

    it("still preserves legitimate user guidance prose after error line", () => {
      // Lines like "Recommendation:" and "Next steps:" are NOT diagnostic headers
      // and must still be delivered.
      const text = [
        "Error: connection timed out",
        "",
        "Recommendation: try restarting the service.",
        "Next steps:",
        "1. Check logs",
        "2. Retry",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request timed out");
      expect(result).toContain("Recommendation");
      expect(result).toContain("Next steps");
      expect(result).toContain("Check logs");
    });

    it("preserves multi-word guidance labels with inline values (not diagnostic keys)", () => {
      // "Next step: retry" and "Suggested fix: restart" are safe guidance,
      // not diagnostic identifiers like "Request ID:" or "Trace ID:".
      const text = [
        "Error: fetch failed",
        "",
        "Next step: retry the command with --verbose.",
        "Suggested fix: restart the service and check connectivity.",
        "Common issues: check the logs for more details.",
        "",
        "1. Run the health check again",
        "2. Verify the config",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("Next step");
      expect(result).toContain("retry the command");
      expect(result).toContain("Suggested fix");
      expect(result).toContain("restart the service");
      expect(result).toContain("Common issues");
      expect(result).toContain("Run the health check again");
    });

    it("preserves safe guidance headings starting with 'Key' (Key finding / Key step)", () => {
      // "Key finding:" / "Key step:" share the CapitalCase + colon form with
      // credential labels like "API Key:" but are safe guidance headings.
      // The credential-label guard must be narrow enough to let them pass.
      // See ClawSweeper P1 finding on PR #96107 (review 2026-07-06).
      const text = [
        "Error: fetch failed",
        "",
        "Key finding: the worker process was OOM-killed.",
        "Key step: retry with --verbose to confirm.",
        "",
        "1. Inspect dmesg",
        "2. Restart the worker",
      ].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).toContain("Key finding");
      expect(result).toContain("OOM-killed");
      expect(result).toContain("Key step");
      expect(result).toContain("retry with --verbose");
      expect(result).toContain("Inspect dmesg");
    });

    it("appends long safe suffix prose without 600-character truncation", () => {
      // Accepted safe prose goes through containsOnlySafeProse and should
      // NOT be routed through formatRawAssistantErrorForUi (which truncates
      // raw text at 600 UTF-16 units).  Build a suffix with 650+ chars of
      // recognizable guidance headings plus a unique tail phrase.
      const tail = "Recommendation: end of long prose verification token here.";
      const line = "Tip: verify the configuration and check all settings.\n";
      const body = Array.from({ length: 40 }, () => line).join("");
      const suffix = `${body}${tail}`;
      expect(suffix.length).toBeGreaterThan(600);

      const text = `Error: fetch failed\n\n${suffix}`;
      const result = sanitizeUserFacingText(text, { errorContext: true });
      expect(result).toContain("LLM request failed");
      expect(result).toContain(tail);
    });
  });

  describe("still rewrites single-line error fragments", () => {
    it("rewrites a bare Error: timeout line", () => {
      const result = sanitizeUserFacingText("Error: connection timed out", {
        errorContext: true,
      });
      expect(result).toBe("LLM request timed out.");
    });

    it("rewrites a bare transport error line (econnrefused)", () => {
      const result = sanitizeUserFacingText("Error: ECONNREFUSED", {
        errorContext: true,
      });
      expect(result).toContain("connection refused");
    });

    it("rewrites a transport error line without suffix content", () => {
      const result = sanitizeUserFacingText("Error: Connection refused", {
        errorContext: true,
      });
      expect(result).toContain("connection refused");
    });
  });

  describe("non-error context is unchanged", () => {
    it("passes through full text when errorContext is false", () => {
      const text = ["Error: connection timed out", "", "Recommendation: retry"].join("\n");
      const result = sanitizeUserFacingText(text, { errorContext: false });
      expect(result).toContain("Recommendation");
      expect(result).toContain("Error: connection timed out");
    });
  });
});
