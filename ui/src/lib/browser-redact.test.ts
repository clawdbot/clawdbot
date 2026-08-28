// @vitest-environment node
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
        "Bearer abcdefghijkl",
        "/Users/alice/private/config.json",
      ].join("\n"),
    );

    expect(redacted).toContain("Authorization: [redacted]");
    expect(redacted).toContain("refresh_token=ya29.l...alue");
    expect(redacted).toContain("client_secret=client...nder");
    expect(redacted).toContain("AIzaSy...7890");
    expect(redacted).toContain("[redacted private key]");
    expect(redacted).toContain("cookie: [redacted]");
    expect(redacted).toContain("Bearer [redacted]");
    expect(redacted).toContain("[redacted path]");
    expect(redacted).not.toContain("supersecretpassword");
    expect(redacted).not.toContain("longOAuthRefreshTokenValue");
    expect(redacted).not.toContain("clientSecretValueThatShouldNotRender");
    expect(redacted).not.toContain("DUMMYGoogleApiKeyValue1234567890");
    expect(redacted).toContain("bare Fireworks key fw-CCC...CCCC");
    expect(redacted).toContain("https://example.test?debug=fw_AAA...AAAA&ok=1");
    expect(redacted).toContain("X-Debug: fpk_BB...BBBB");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("verySensitiveCookieValue");
    expect(redacted).not.toContain("abcdefghijkl");
    expect(redacted).not.toContain("/Users/alice/private/config.json");
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

  it.each([
    ["expanded GitHub", `gho_${"A".repeat(20)}`],
    ["GitLab", `glpat-${"A".repeat(24)}`],
    ["Slack webhook", `https://hooks.slack.com/services/TABC123/BABC123/${"A".repeat(24)}`],
    ["Discord webhook", `https://discord.com/api/webhooks/123456789012345678/${"A".repeat(60)}`],
    ["Discord bot", `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(27)}`],
    ["Stripe", `sk_live_${"A".repeat(20)}`],
    ["SendGrid", `SG.${"A".repeat(15)}.${"B".repeat(15)}`],
    ["DigitalOcean", `dop_v1_${"A".repeat(20)}`],
    ["fal", `fal_${"A".repeat(20)}`],
    ["Fernet", `gAAAA${"A".repeat(24)}`],
  ])("redacts the canonical %s secret family", (label, secret) => {
    const prefix = label === "Discord bot" ? "discord token " : "";
    expect(redactToolDetail(`${prefix}${secret}`)).not.toContain(secret);
  });

  it("redacts URL userinfo and database connection passwords", () => {
    const httpPassword = "http-password-value";
    const databasePassword = "database-password-value";
    const redacted = redactToolDetail(
      `https://user:${httpPassword}@example.test postgres://user:${databasePassword}@db.test/app`,
    );

    expect(redacted).not.toContain(httpPassword);
    expect(redacted).not.toContain(databasePassword);
  });

  it("redacts AWS secret-access-key fields", () => {
    const secret = "Aa0/".repeat(10);
    expect(redactToolDetail(`{"awsSecretAccessKey":"${secret}"}`)).not.toContain(secret);
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
    expect(redactToolPayloadText(`{"accessToken":"${token}"}`)).toBe(`{"accessToken":"${masked}"}`);
  });

  it("does not trust mask-shaped input as already redacted", () => {
    expect(redactToolPayloadText("OPENAI_API_KEY=abcde...wxyz")).toBe(
      "OPENAI_API_KEY=abcde....wxyz",
    );
  });

  it("redacts replacement-template text literally without changing surrounding text", () => {
    const markerLike = "\u{e000}0\u{e001}";
    expect(redactToolPayloadText(`${markerLike} OPENAI_API_KEY=$\`abcdxxxxxxxxwxyz`)).toBe(
      `${markerLike} OPENAI_API_KEY=$\`abcd...wxyz`,
    );
  });

  it("redacts the captured value when key and value repeat", () => {
    expect(redactToolPayloadText("LONG_LONG_LONG_TOKEN=LONG_LONG_LONG_TOKEN")).toBe(
      "LONG_LONG_LONG_TOKEN=LONG_L...OKEN",
    );
  });

  it("fully redacts a nested credential after the outer match", () => {
    expect(redactToolPayloadText('client_secret: "TOKEN=abcdefghijklmno&abcdefghij"')).toBe(
      'client_secret: "TOKEN=[redacted]"',
    );
  });
});
