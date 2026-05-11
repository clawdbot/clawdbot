import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  formatAssistantErrorText,
  getApiErrorPayloadFingerprint,
  formatRawAssistantErrorForUi,
  isRawApiErrorPayload,
  sanitizeUserFacingText,
} from "./pi-embedded-helpers.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

describe("formatAssistantErrorText", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    makeAssistantMessageFixture({
      errorMessage,
      content: [{ type: "text", text: errorMessage }],
    });

  it("returns a friendly message for context overflow", () => {
    const msg = makeAssistantError("request_too_large");
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns context overflow for Anthropic 'Request size exceeds model context window'", () => {
    // This is the new Anthropic error format that wasn't being detected.
    // Without the fix, this falls through to the invalidRequest regex and returns
    // "LLM request rejected: Request size exceeds model context window"
    // instead of the context overflow message, preventing auto-compaction.
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Request size exceeds model context window"}}',
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns context overflow for Kimi 'model token limit' errors", () => {
    const msg = makeAssistantError(
      "error, status code: 400, message: Invalid request: Your request exceeded model token limit: 262144 (requested: 291351)",
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns context overflow for Ollama 'prompt too long' errors (#34005)", () => {
    const msg = makeAssistantError(
      'Ollama API error 400: {"StatusCode":400,"Status":"400 Bad Request","error":"prompt too long; exceeded max context length by 4 tokens"}',
    );
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
  it("returns a reasoning-required message for mandatory reasoning endpoint errors", () => {
    const msg = makeAssistantError(
      "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Reasoning is required");
    expect(result).toContain("/think minimal");
    expect(result).not.toContain("Context overflow");
  });
  it("returns a friendly message for Anthropic role ordering", () => {
    const msg = makeAssistantError('messages: roles must alternate between "user" and "assistant"');
    expect(formatAssistantErrorText(msg)).toContain("Message ordering conflict");
  });
  it("returns a friendly message for Anthropic overload errors", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_123"}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
  });
  it("returns a model-switch hint for OpenAI model capacity errors", () => {
    const msg = makeAssistantError("Selected model is at capacity. Please try a different model.");
    expect(formatAssistantErrorText(msg)).toBe(
      "⚠️ Selected model is at capacity. Try a different model, or wait and retry.",
    );
  });
  it("returns a recovery hint when tool call input is missing", () => {
    const msg = makeAssistantError("tool_use.input: Field required");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Session history looks corrupted");
    expect(result).toContain("/new");
  });
  it("returns a recovery hint for replay-invalid connection mismatch errors", () => {
    const msg = makeAssistantError("401 input item ID does not belong to this connection");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Session history or replay state is invalid");
    expect(result).toContain("/new");
  });
  it("handles JSON-wrapped role errors", () => {
    const msg = makeAssistantError('{"error":{"message":"400 Incorrect role information"}}');
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("Message ordering conflict");
    expect(result).not.toContain("400");
  });
  it("suppresses raw error JSON payloads that are not otherwise classified", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe("LLM error server_error: Something exploded");
  });
  it("sanitizes Codex error-prefixed JSON payloads", () => {
    const msg = makeAssistantError(
      'Codex error: {"type":"error","error":{"message":"Something exploded","type":"server_error"},"sequence_number":2}',
    );
    expect(formatAssistantErrorText(msg)).toBe("LLM error server_error: Something exploded");
  });
  it("returns a friendly billing message for credit balance errors", () => {
    const msg = makeAssistantError("Your credit balance is too low to access the Anthropic API.");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for HTTP 402 errors", () => {
    const msg = makeAssistantError("HTTP 402 Payment Required");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for insufficient credits", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg);
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("includes provider and assistant model in billing message when provider is given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg, { provider: "Anthropic" });
    expect(result).toBe(formatBillingErrorMessage("Anthropic", "test-model"));
    expect(result).toContain("Anthropic");
    expect(result).not.toContain("API provider");
  });
  it("uses the active assistant model for billing message context", () => {
    const msg = makeAssistantError("insufficient credits");
    msg.model = "claude-3-5-sonnet";
    const result = formatAssistantErrorText(msg, { provider: "Anthropic" });
    expect(result).toBe(formatBillingErrorMessage("Anthropic", "claude-3-5-sonnet"));
  });
  it("returns generic billing message when provider is not given", () => {
    const msg = makeAssistantError("insufficient credits");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("API provider");
    expect(result).toBe(BILLING_ERROR_USER_MESSAGE);
  });
  it("returns a friendly billing message for flat JSON insufficient_balance payloads (#74079)", () => {
    const msg = makeAssistantError(
      '{"error":"insufficient_balance","message":"Insufficient MBT balance. Top up or upgrade your subscription to continue.","upgradeUrl":"/settings/billing"}',
    );
    const result = formatAssistantErrorText(msg, {
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    expect(result).toBe(formatBillingErrorMessage("google", "gemini-3.1-pro-preview"));
  });
  it("returns a friendly message for rate limit errors", () => {
    const msg = makeAssistantError("429 rate limit reached");
    expect(formatAssistantErrorText(msg)).toContain("rate limit reached");
  });

  it("surfaces provider-specific rate limit message with reset time (#54433)", () => {
    const msg = makeAssistantError(
      "You have hit your ChatGPT usage limit (go plan). Try again in ~4381 min.",
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("4381 min");
    expect(result).toContain("go plan");
    expect(result).not.toBe("⚠️ API rate limit reached. Please try again later.");
  });

  it("surfaces provider-specific rate limit message from JSON payload (#54433)", () => {
    const msg = makeAssistantError(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit reached. Try again in 30 seconds."}}',
    );
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("30 seconds");
    expect(result).not.toBe("⚠️ API rate limit reached. Please try again later.");
  });

  it("returns generic rate limit message when no specific details are present", () => {
    const msg = makeAssistantError("429 Too Many Requests");
    expect(formatAssistantErrorText(msg)).toBe(
      "⚠️ API rate limit reached. Please try again later.",
    );
  });

  it("strips leading HTTP status code prefix from non-JSON rate limit messages", () => {
    const msg = makeAssistantError("429 Your quota has been exhausted, try again in 24 hours");
    const result = formatAssistantErrorText(msg);
    expect(result).toContain("try again in 24 hours");
    expect(result).not.toMatch(/^⚠️ 429\b/);
    expect(result).toBe("⚠️ Your quota has been exhausted, try again in 24 hours");
  });

  it("returns upstream HTML copy for HTML quota pages", () => {
    const msg = makeAssistantError(
      "429 <!DOCTYPE html><html><body>Your quota is exhausted</body></html>",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The provider returned an HTML error page instead of an API response. This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. Retry in a moment or check provider status.",
    );
  });

  it("returns upstream HTML copy for prefixed 521 HTML rate-limit pages", () => {
    const msg = makeAssistantError(
      "Error: 521 <!DOCTYPE html><html><body>rate limit</body></html>",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "The provider returned an HTML error page instead of an API response. This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. Retry in a moment or check provider status.",
    );
  });

  it("does not misdiagnose standalone Cloudflare challenge HTML as DNS", () => {
    const msg = makeAssistantError(`<!DOCTYPE html>
<html>
  <head>
    <title>Just a moment...</title>
    <link rel="dns-prefetch" href="//chatgpt.com">
  </head>
  <body>
    <span id="challenge-error-text">Enable JavaScript and cookies to continue</span>
    <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
  </body>
</html>`);
    expect(formatAssistantErrorText(msg)).toBe(
      "The provider returned an HTML error page instead of an API response. This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. Retry in a moment or check provider status.",
    );
  });

  it("returns a friendly message for empty stream chunk errors", () => {
    const msg = makeAssistantError("request ended without sending any chunks");
    expect(formatAssistantErrorText(msg)).toBe("LLM request timed out.");
  });

  it("returns a connection-refused message for ECONNREFUSED failures", () => {
    const msg = makeAssistantError("connect ECONNREFUSED 127.0.0.1:443 during upstream call");
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: connection refused by the provider endpoint.",
    );
  });

  it.each(["disk full", "ENOSPC: no space left on device, write"])(
    "returns a friendly disk-space message for %s",
    (errorMessage) => {
      const msg = makeAssistantError(errorMessage);
      expect(formatAssistantErrorText(msg)).toBe(
        "OpenClaw could not write local session data because the disk is full. Free some disk space and try again.",
      );
    },
  );

  it("returns a DNS-specific message for provider lookup failures", () => {
    const msg = makeAssistantError("dial tcp: lookup api.example.com: no such host (ENOTFOUND)");
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: DNS lookup for the provider endpoint failed.",
    );
  });

  it("returns an interrupted-connection message for socket hang ups", () => {
    const msg = makeAssistantError("socket hang up");
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: network connection was interrupted.",
    );
  });

  it("returns an explicit re-authentication message for OAuth refresh failures", () => {
    const msg = makeAssistantError(
      "OAuth token refresh failed for openai-codex: invalid_grant. Please try again or re-authenticate.",
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "Authentication refresh failed. Re-authenticate this provider and try again.",
    );
  });

  it("returns a contention-specific message for OAuth refresh lock timeouts", () => {
    const msg = makeAssistantError("file lock timeout for /tmp/openclaw-oauth-refresh.lock");
    expect(formatAssistantErrorText(msg)).toBe(
      "Authentication refresh is already in progress elsewhere and this attempt timed out waiting for it. Retry in a moment.",
    );
  });

  it("returns a timeout-specific message for OAuth refresh hard timeouts", () => {
    const msg = makeAssistantError(
      'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai-codex)" exceeded hard timeout (120000ms)',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "Authentication refresh timed out before the provider completed. Retry in a moment; re-authenticate only if it keeps failing.",
    );
  });

  it("returns a missing-scope message for OpenAI Codex scope failures", () => {
    const msg = makeAssistantError(
      '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write model.request"}}',
    );
    expect(formatAssistantErrorText(msg, { provider: "openai-codex" })).toBe(
      "Authentication is missing the required OpenAI Codex scopes. Re-run OpenAI/Codex login and try again.",
    );
  });

  it("returns a missing-scope message for raw OpenAI Codex scope payloads without an HTTP prefix", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write model.request"},"code":401}',
    );
    expect(formatAssistantErrorText(msg, { provider: "openai-codex" })).toBe(
      "Authentication is missing the required OpenAI Codex scopes. Re-run OpenAI/Codex login and try again.",
    );
  });

  it("does not misdiagnose non-Codex permission errors as missing-scope failures", () => {
    const msg = makeAssistantError(
      '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write model.request"}}',
    );
    expect(formatAssistantErrorText(msg, { provider: "openai" })).not.toContain(
      "required OpenAI Codex scopes",
    );
  });

  it("does not misdiagnose generic Codex permission failures as missing-scope failures", () => {
    const msg = makeAssistantError(
      '403 {"type":"error","error":{"type":"permission_error","message":"Insufficient permissions for this organization"}}',
    );
    expect(formatAssistantErrorText(msg, { provider: "openai-codex" })).not.toContain(
      "required OpenAI Codex scopes",
    );
  });

  it("returns an HTML-403 auth message for HTML provider auth failures", () => {
    const msg = makeAssistantError("403 <!DOCTYPE html><html><body>Access denied</body></html>");
    expect(formatAssistantErrorText(msg)).toBe(
      "Authentication failed with an HTML 403 response from the provider. Re-authenticate and verify your provider account access.",
    );
  });

  it("returns a proxy-specific message for proxy misroutes", () => {
    const msg = makeAssistantError("407 Proxy Authentication Required");
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: proxy or tunnel configuration blocked the provider request.",
    );
  });

  it("keeps non-transport config errors that mention proxy settings actionable", () => {
    const msg = makeAssistantError(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
    expect(formatAssistantErrorText(msg)).toContain(
      'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
    );
    expect(formatAssistantErrorText(msg)).not.toBe(
      "LLM request failed: proxy or tunnel configuration blocked the provider request.",
    );
  });

  it("sanitizes invalid streaming event order errors", () => {
    const msg = makeAssistantError(
      'Unexpected event order, got message_start before receiving "message_stop"',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request failed: provider returned an invalid streaming response. Please try again.",
    );
  });

  it("sanitizes transport-classified malformed streaming fragments (#59076)", () => {
    const msg = makeAssistantError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE);
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM streaming response contained a malformed fragment. Please try again.",
    );
  });

  it("does not broadly rewrite non-streaming 'Unexpected token' JSON parse errors", () => {
    const msg = makeAssistantError("Unexpected token < in JSON at position 0");
    expect(formatAssistantErrorText(msg)).toBe("Unexpected token < in JSON at position 0");
  });

  it("does not rewrite non-streaming provider JSON request-validation diagnostics", () => {
    const msg = makeAssistantError("Expected value in JSON at position 12 for messages.0.content");
    expect(formatAssistantErrorText(msg)).toBe(
      "Expected value in JSON at position 12 for messages.0.content",
    );
  });

  it("keeps provider request-validation JSON diagnostics actionable", () => {
    const msg = makeAssistantError(
      '{"type":"error","error":{"type":"invalid_request_error","message":"Expected value in JSON at position 12 for messages.0.content"}}',
    );
    expect(formatAssistantErrorText(msg)).toBe(
      "LLM request rejected: Expected value in JSON at position 12 for messages.0.content",
    );
  });
});

describe("formatRawAssistantErrorForUi", () => {
  it("renders HTTP code + type + message from Anthropic payloads", () => {
    const text = formatRawAssistantErrorForUi(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited."},"request_id":"req_123"}',
    );

    expect(text).toContain("HTTP 429");
    expect(text).toContain("rate_limit_error");
    expect(text).toContain("Rate limited.");
    expect(text).not.toContain("req_123");
  });

  it("renders a generic unknown error message when raw is empty", () => {
    expect(formatRawAssistantErrorForUi("")).toContain("unknown error");
  });

  it("formats plain HTTP status lines", () => {
    expect(formatRawAssistantErrorForUi("500 Internal Server Error")).toBe(
      "HTTP 500: Internal Server Error",
    );
  });

  it("formats colon-delimited HTTP status lines", () => {
    expect(formatRawAssistantErrorForUi("HTTP 410: No body")).toBe("HTTP 410: No body");
  });

  it("sanitizes HTML error pages into a clean unavailable message", () => {
    const htmlError = `521 <!DOCTYPE html>
<html lang="en-US">
  <head><title>Web server is down | example.com | Cloudflare</title></head>
  <body>Ray ID: abc123</body>
</html>`;

    expect(formatRawAssistantErrorForUi(htmlError)).toBe(
      "The AI service is temporarily unavailable (HTTP 521). Please try again in a moment.",
    );
  });

  it("formats standalone Cloudflare challenge HTML into a clean provider error", () => {
    const htmlError = `<!DOCTYPE html>
<html lang="en-US">
  <head><title>Just a moment...</title></head>
  <body>
    <span id="challenge-error-text">Enable JavaScript and cookies to continue</span>
    <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
  </body>
</html>`;

    expect(formatRawAssistantErrorForUi(htmlError)).toBe(
      "The provider returned an HTML error page instead of an API response. This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. Retry in a moment or check provider status.",
    );
  });
});

describe("raw API error payload helpers", () => {
  it("recognizes provider-prefixed JSON payloads for observation fingerprints", () => {
    const raw =
      'Ollama API error: {"type":"error","error":{"type":"server_error","message":"Boom"},"request_id":"req_123"}';

    expect(isRawApiErrorPayload(raw)).toBe(true);
    expect(getApiErrorPayloadFingerprint(raw)).toContain("server_error");
    expect(getApiErrorPayloadFingerprint(raw)).toContain("req_123");
  });

  it("recognizes flat JSON payloads with string error code and message (#74079)", () => {
    const raw =
      '{"error":"insufficient_balance","message":"Insufficient MBT balance. Top up or upgrade your subscription to continue.","upgradeUrl":"/settings/billing"}';
    expect(isRawApiErrorPayload(raw)).toBe(true);
    expect(formatRawAssistantErrorForUi(raw)).toBe(
      "LLM error insufficient_balance: Insufficient MBT balance. Top up or upgrade your subscription to continue.",
    );
  });
});

describe("sanitizeUserFacingText — streaming JSON parse error (#59076)", () => {
  it("rewrites transport-classified malformed streaming fragments in error context", () => {
    const result = sanitizeUserFacingText(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, {
      errorContext: true,
    });
    expect(result).toBe("LLM streaming response contained a malformed fragment. Please try again.");
  });

  it("does not rewrite JSON parse error when not in error context", () => {
    // When not in error context, the text could be legitimate assistant content
    // mentioning JSON errors. Don't rewrite.
    const text =
      "Expected ',' or '}' after property value in JSON at position 334 (line 1 column 335)";
    const result = sanitizeUserFacingText(text, { errorContext: false });
    expect(result).toBe(text);
  });
});
