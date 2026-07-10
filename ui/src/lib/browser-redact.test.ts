// Control UI tests cover browser redact behavior.
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
        `bare Fireworks key fw-${"C".repeat(40)}`,
        `https://example.test?debug=fw_${"A".repeat(40)}&ok=1`,
        `X-Debug: fpk_${"B".repeat(40)}`,
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
    expect(redacted).toContain("bare Fireworks key fw-CCC...CCCC");
    expect(redacted).toContain("https://example.test?debug=fw_AAA...AAAA&ok=1");
    expect(redacted).toContain("X-Debug: fpk_BB...BBBB");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("verySensitiveCookieValue");
    for (const masked of ["fw-CCC...CCCC", "fw_AAA...AAAA", "fpk_BB...BBBB"]) {
      expect(redactToolDetail(masked)).toBe(masked);
    }
  });

  it("preserves long non-token identifiers containing Fireworks prefixes", () => {
    const input = [
      `fixturefw-${"C".repeat(40)}`,
      `fixture_fw_${"A".repeat(40)}`,
      `fixture_fpk_${"B".repeat(40)}`,
    ].join(" ");

    expect(redactToolDetail(input)).toBe(input);
  });

  it("exposes the tool payload redaction name used by shared display modules", () => {
    expect(redactToolPayloadText("OPENAI_API_KEY=sk-1234567890abcdef")).toBe(
      "OPENAI_API_KEY=sk-123...cdef",
    );
  });

  it.each([
    ["leading split", "abcde😀xxxxxxxxwxyz", "abcde...wxyz"],
    ["trailing split", "abcdefghijklm😀xyz", "abcdef...xyz"],
    ["intact leading pair", "abcd😀xxxxxxxxwxyz", "abcd😀...wxyz"],
    ["intact trailing pair", "abcdefghijklmn😀xy", "abcdef...😀xy"],
  ])("masks tool payload tokens with a UTF-16-safe %s", (_label, token, masked) => {
    expect(redactToolPayloadText(`{"token":"${token}"}`)).toBe(`{"token":"${masked}"}`);
  });

  it("does not trust mask-shaped input as already redacted", () => {
    expect(redactToolPayloadText("TOKEN=abcde...wxyz")).toBe("TOKEN=abcde....wxyz");
  });

  it("redacts replacement-template text literally without changing surrounding text", () => {
    const markerLike = "\u{e000}0\u{e001}";
    expect(redactToolPayloadText(`${markerLike} TOKEN=$\`abcdxxxxxxxxwxyz`)).toBe(
      `${markerLike} TOKEN=$\`abcd...wxyz`,
    );
  });

  it("redacts the captured value when key and value repeat", () => {
    expect(redactToolPayloadText("LONG_LONG_LONG_TOKEN=LONG_LONG_LONG_TOKEN")).toBe(
      "LONG_LONG_LONG_TOKEN=LONG_L...OKEN",
    );
  });

  it("prefers an outer credential match over a nested one", () => {
    expect(redactToolPayloadText('cookie: "TOKEN=abcdefghijklmno&abcdefghij"')).toBe(
      'cookie: "TOKEN=...ghij"',
    );
  });
});
