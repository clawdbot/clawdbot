import { describe, expect, it } from "vitest";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  isTimeoutErrorMessage,
} from "../failover/classify.js";
import { classifyProviderRuntimeFailureKind } from "./provider-runtime-failure.js";

describe("classifyProviderRuntimeFailureKind", () => {
  it("classifies complete HTML after an HTTP reason phrase as upstream_html", () => {
    const raw = "HTTP 502 Bad Gateway\n\n<!doctype html><html><body>down</body></html>";

    expect(classifyProviderRuntimeFailureKind(raw)).toBe("upstream_html");
  });

  it("classifies generic resource-exhausted codes as rate_limit", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai",
        code: "RESOURCE_EXHAUSTED",
        message: "",
      }),
    ).toBe("rate_limit");
  });

  it.each([
    { provider: "openai", code: "SERVER_ERROR" },
    { provider: "google", code: "UNAVAILABLE" },
    { provider: "anthropic", code: "RATE_LIMIT_ERROR" },
  ] as const)(
    "does not report code-only $provider $code failures as empty responses",
    ({ provider, code }) => {
      expect(classifyProviderRuntimeFailureKind({ provider, code, message: "" })).not.toBe(
        "empty_response",
      );
    },
  );
  it("classifies missing scope failures", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai",
        message:
          '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
      }),
    ).toBe("auth_scope");
  });

  it("classifies raw missing scope payloads without an HTTP prefix", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai",
        message:
          '{"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"},"code":401}',
      }),
    ).toBe("auth_scope");
  });

  it("does not classify other provider permission errors as OpenAI scope failures", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "anthropic",
        message:
          '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
      }),
    ).not.toBe("auth_scope");
  });

  it("does not treat generic OpenAI permission failures as missing scope failures", () => {
    expect(
      classifyProviderRuntimeFailureKind({
        provider: "openai",
        message:
          '403 {"type":"error","error":{"type":"permission_error","message":"Insufficient permissions for this organization"}}',
      }),
    ).not.toBe("auth_scope");
  });

  it("classifies OAuth refresh failures", () => {
    const refreshFailures = [
      "OAuth token refresh failed for openai: invalid_grant. Please try again or re-authenticate.",
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "Your authentication session could not be refreshed automatically. Please log out and sign in again.",
    ];
    for (const message of refreshFailures) {
      expect(classifyProviderRuntimeFailureKind(message)).toBe("auth_refresh");
      expect(classifyFailoverReason(message, { provider: "openai" })).toBe("auth_permanent");
    }
  });

  it("does not make uncertain OAuth refresh wrappers terminal", () => {
    const message =
      "OAuth token refresh failed for openai: file lock timeout for /tmp/agent/auth-profiles.json. Please try again or re-authenticate.";
    expect(classifyProviderRuntimeFailureKind(message)).toBe("auth_refresh");
    expect(classifyFailoverReason(message, { provider: "openai" })).toBe("auth");
  });

  it("keeps Codex entitlement and usage-limit payloads out of terminal auth", () => {
    const entitlementMessages = [
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM.",
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits, try again later.",
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"You\\u0027ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), try again after 11:34 AM."}}',
    ];
    for (const message of entitlementMessages) {
      expect(classifyProviderRuntimeFailureKind(message)).not.toBe("auth_refresh");
      expect(classifyFailoverReason(message, { provider: "openai" })).toBe("rate_limit");
    }
  });

  it("classifies OAuth refresh timeouts and lock contention distinctly", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        'OAuth refresh call "refreshProviderOAuthCredentialWithPlugin(openai)" exceeded hard timeout (120000ms)',
      ),
    ).toBe("refresh_timeout");
    expect(
      classifyProviderRuntimeFailureKind("file lock timeout for /tmp/openclaw-oauth-refresh.lock"),
    ).toBe("refresh_contention");
    expect(
      classifyProviderRuntimeFailureKind({
        code: "refresh_contention",
        message:
          "OAuth token refresh failed for openai: OAuth refresh failed (refresh_contention): another process is already refreshing openai for openai:default. Please wait for the in-flight refresh to finish and retry.",
      }),
    ).toBe("refresh_contention");
    expect(
      classifyProviderRuntimeFailureKind(
        "OAuth token refresh failed for openai: file lock timeout for /tmp/agent/auth-profiles.json. Please try again or re-authenticate.",
      ),
    ).toBe("auth_refresh");
  });

  it("classifies wrapped OpenAI Codex callback validation failures distinctly", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        "OpenAI Codex OAuth failed (callback_validation_failed): State mismatch",
      ),
    ).toBe("callback_validation");
  });

  it("classifies HTML 403 auth failures", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        "403 <!DOCTYPE html><html><body>Access denied</body></html>",
      ),
    ).toBe("auth_html");
  });

  it("classifies HTML 401 auth failures", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        "401 <!DOCTYPE html><html><body>Unauthorized</body></html>",
      ),
    ).toBe("auth_html");
  });

  it("classifies proxy, dns, timeout, schema, sandbox, and replay failures", () => {
    expect(classifyProviderRuntimeFailureKind("407 Proxy Authentication Required")).toBe("proxy");
    expect(
      classifyProviderRuntimeFailureKind("dial tcp: lookup api.example.com: no such host"),
    ).toBe("dns");
    expect(classifyProviderRuntimeFailureKind("socket hang up")).toBe("timeout");
    expect(
      classifyProviderRuntimeFailureKind({
        code: "CERT_HAS_EXPIRED",
        message: "certificate has expired",
      }),
    ).toBe("tls_certificate");
    expect(
      classifyProviderRuntimeFailureKind({
        code: "CERT_REVOKED",
        message: "TLS validation failed",
      }),
    ).toBe("tls_certificate");
    expect(
      classifyProviderRuntimeFailureKind({
        status: 400,
        code: "CERT_HAS_EXPIRED",
        message: "certificate field rejected",
      }),
    ).toBe("unclassified");
    expect(
      classifyProviderRuntimeFailureKind("INVALID_REQUEST_ERROR: string should match pattern"),
    ).toBe("schema");
    expect(classifyProviderRuntimeFailureKind("exec denied (allowlist-miss):")).toBe(
      "sandbox_blocked",
    );
    expect(classifyProviderRuntimeFailureKind("tool_use.input: Field required")).toBe(
      "replay_invalid",
    );
    expect(
      classifyProviderRuntimeFailureKind("401 input item ID does not belong to this connection"),
    ).toBe("replay_invalid");
  });

  it("classifies expired Anthropic thinking signatures as replay invalid", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        '{"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.440: Invalid `signature` in `thinking` block"}}',
      ),
    ).toBe("replay_invalid");
    expect(
      classifyProviderRuntimeFailureKind(
        "ValidationException: invalid signature on thinking block",
      ),
    ).toBe("replay_invalid");
    expect(
      classifyProviderRuntimeFailureKind(
        "ValidationException: signature present in thinking block",
      ),
    ).not.toBe("replay_invalid");
    expect(classifyProviderRuntimeFailureKind("Invalid signature")).not.toBe("replay_invalid");
  });

  it("splits ambiguous provider runtime failures instead of collapsing to unknown", () => {
    expect(classifyProviderRuntimeFailureKind({})).toBe("empty_response");
    expect(classifyProviderRuntimeFailureKind("Unknown error (no error details in response)")).toBe(
      "no_error_details",
    );
    expect(classifyProviderRuntimeFailureKind("provider sent a strange opaque failure")).toBe(
      "unclassified",
    );
  });

  it("does not classify generic config errors that mention proxy settings as proxy failures", () => {
    expect(
      classifyProviderRuntimeFailureKind(
        'Model-provider request.proxy/request.tls is not yet supported for api "ollama"',
      ),
    ).not.toBe("proxy");
  });

  it("classifies google-style INTERNAL status payloads as timeout", () => {
    expect(
      classifyFailoverReason(
        'ERROR provider=google model=gemini-3.1-flash-lite-preview: got status: INTERNAL, details: {"code":500,"status":"INTERNAL"}',
      ),
    ).toBe("timeout");
    expect(
      classifyFailoverReason(
        'got status: INTERNAL. {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
      ),
    ).toBe("timeout");
  });

  it("does not classify google-style INTERNAL payloads without a 500 code as timeout", () => {
    const sample =
      'got status: INTERNAL. {"error":{"code":400,"message":"Request malformed","status":"INTERNAL"}}';
    expect(isTimeoutErrorMessage(sample)).toBe(false);
    expect(classifyFailoverReason(sample)).toBeNull();
    expect(isFailoverErrorMessage(sample)).toBe(false);
  });
});
