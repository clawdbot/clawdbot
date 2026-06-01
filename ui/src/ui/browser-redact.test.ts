import { describe, expect, it } from "vitest";
import { redactToolDetail, redactToolPayloadText } from "./browser-redact.ts";

describe("browser tool detail redaction", () => {
  it("redacts tool detail credential families without Node config imports", () => {
    const redacted = redactToolDetail(
      [
        "Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk",
        "curl 'https://example.test?refresh_token=ya29.longOAuthRefreshTokenValue&ok=1'",
        "client_secret=clientSecretValueThatShouldNotRender",
        "AIzaSyDUMMYGoogleApiKeyValue1234567890",
        "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        'cookie: "sessionid=verySensitiveCookieValue"',
      ].join("\n"),
    );

    expect(redacted).toContain("Authorization: Basic dXNlcj...b3Jk");
    expect(redacted).toContain("refresh_token=ya29.l...alue");
    expect(redacted).toContain("client_secret=client...nder");
    expect(redacted).toContain("AIzaSy...7890");
    expect(redacted).toContain(
      "-----BEGIN PRIVATE KEY-----\n...redacted...\n-----END PRIVATE KEY-----",
    );
    expect(redacted).toContain('cookie: "sessio...alue"');
    expect(redacted).not.toContain("supersecretpassword");
    expect(redacted).not.toContain("longOAuthRefreshTokenValue");
    expect(redacted).not.toContain("clientSecretValueThatShouldNotRender");
    expect(redacted).not.toContain("DUMMYGoogleApiKeyValue1234567890");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("verySensitiveCookieValue");
  });

  it("exposes the tool payload redaction name used by shared display modules", () => {
    expect(redactToolPayloadText("OPENAI_API_KEY=sk-1234567890abcdef")).toBe(
      "OPENAI_API_KEY=sk-123...cdef",
    );
  });
});
