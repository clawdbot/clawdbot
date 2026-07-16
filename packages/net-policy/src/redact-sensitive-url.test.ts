// Network Policy tests cover redact sensitive url behavior.
import { describe, expect, it } from "vitest";
import {
  isSensitiveUrlQueryParamName,
  isSensitiveUrlConfigPath,
  SENSITIVE_URL_HINT_TAG,
  hasSensitiveUrlHintTag,
  redactSensitiveUrl,
  redactSensitiveUrlLikeString,
} from "./redact-sensitive-url.js";

describe("redactSensitiveUrl", () => {
  it("redacts userinfo and sensitive query params from valid URLs", () => {
    expect(redactSensitiveUrl("https://user:pass@example.com/mcp?token=secret&safe=value")).toBe(
      "https://***:***@example.com/mcp?token=***&safe=value",
    );
  });

  it("treats query param names case-insensitively", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?Access_Token=secret")).toBe(
      "https://example.com/mcp?Access_Token=***",
    );
  });

  it("redacts encoded and invisible-spliced sensitive query param names", () => {
    expect(
      redactSensitiveUrl("https://example.com/mcp?client%5Fse%E2%80%8Bcret=secret&safe=value"),
    ).toBe("https://example.com/mcp?client_se%E2%80%8Bcret=***&safe=value");
  });

  it("redacts encoded sensitive query names with decoded whitespace and control separators", () => {
    expect(
      redactSensitiveUrl("https://example.com/mcp?client%5Fse%20cret=space&client%5Fse%00cret=nul"),
    ).toBe("https://example.com/mcp?client_se+cret=***&client_se%00cret=***");
  });

  it("redacts query names with plus-encoded separators", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?client_se+cret=secret&safe=value")).toBe(
      "https://example.com/mcp?client_se+cret=***&safe=value",
    );
  });

  it("keeps non-sensitive URLs unchanged", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?safe=value")).toBe(
      "https://example.com/mcp?safe=value",
    );
    expect(redactSensitiveUrl("https://example.test/?discount=100%25")).toBe(
      "https://example.test/?discount=100%25",
    );
  });

  it("redacts Telegram bot tokens from URL paths", () => {
    expect(
      redactSensitiveUrl(
        "https://telegram.internal/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd/getMe",
      ),
    ).toBe("https://telegram.internal/bot***/getMe");
    expect(
      redactSensitiveUrl(
        "https://api.telegram.org/bot123456%3AABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd/getMe",
      ),
    ).toBe("https://api.telegram.org/bot***/getMe");
  });

  it("redacts credentials in literal and encoded nested URLs", () => {
    const nested = joinUrlParts(
      "https://nested-user",
      ":",
      "nested-pass",
      "@inner.example/cb?access",
      "_token",
      "=",
      "nested-token",
    );
    for (const value of [
      nested,
      encodeURIComponent(nested),
      encodeURIComponent(encodeURIComponent(nested)),
    ]) {
      const redacted = redactSensitiveUrl(
        `https://outer.example/connect?redirect=${encodeURIComponent(value)}&keep=visible`,
      );
      expect(redacted).not.toContain("nested-user");
      expect(redacted).not.toContain("nested-pass");
      expect(redacted).not.toContain("nested-token");
      expect(new URL(redacted).searchParams.get("keep")).toBe("visible");
    }
  });

  it("redacts sensitive query params in query and hash-router fragments", () => {
    expect(
      redactSensitiveUrl(
        joinUrlParts("https://example.com/cb#access", "_token", "=", "secret", "&keep=visible"),
      ),
    ).toBe(joinUrlParts("https://example.com/cb#access", "_token", "=", "***", "&keep=visible"));
    expect(
      redactSensitiveUrl(
        joinUrlParts("https://example.com/#/cb?to", "ken=", "secret", "&keep=visible"),
      ),
    ).toBe(joinUrlParts("https://example.com/#/cb?to", "ken=", "***", "&keep=visible"));
  });

  it("redacts sensitive encoded fragments without changing safe encoded fragments", () => {
    const sensitiveFragment = encodeURIComponent(
      joinUrlParts("access", "_token", "=", "secret", "&keep=visible"),
    );
    expect(redactSensitiveUrl(`https://example.com/cb#${sensitiveFragment}`)).toBe(
      "https://example.com/cb#access_token%3D***%26keep%3Dvisible",
    );

    const safeUrl = "https://example.com/cb#keep%3Dvisible%26next%3Dsafe";
    expect(redactSensitiveUrl(safeUrl)).toBe(safeUrl);
  });

  it("preserves safe nested URLs, fragments, and duplicate query ordering byte-for-byte", () => {
    const safeUrl =
      "https://outer.example/cb?next=https%3A%2F%2Finner.example%2Fpath%3Fkeep%3Dvisible&keep=one&keep=two#https%3A%2F%2Ffragment.example%2Fpath%3Fok%3D1";
    expect(redactSensitiveUrl(safeUrl)).toBe(safeUrl);

    expect(
      redactSensitiveUrl(
        joinUrlParts("https://example.com/?keep=one&keep=two&to", "ken=", "a", "&to", "ken=b"),
      ),
    ).toBe(joinUrlParts("https://example.com/?keep=one&keep=two&to", "ken=", "***"));
  });

  it("is idempotent after nested URL redaction", () => {
    const input =
      "https://outer.example/?next=https%3A%2F%2Fu%3Ap%40inner.example%2F%3Ftoken%3Dsecret";
    const once = redactSensitiveUrl(input);
    expect(redactSensitiveUrl(once)).toBe(once);
  });

  it("fails closed when nested URL encoding exceeds the recursion bound", () => {
    let nested = joinUrlParts(
      "https://deep-user",
      ":",
      "deep-pass",
      "@inner.example/?to",
      "ken=",
      "deep-token",
    );
    for (let index = 0; index < 12; index += 1) {
      nested = `https://level-${index}.example/?next=${encodeURIComponent(nested)}`;
    }
    const redacted = redactSensitiveUrl(nested);
    expect(redacted).not.toContain("deep-user");
    expect(redacted).not.toContain("deep-pass");
    expect(redacted).not.toContain("deep-token");
    expect(redacted).toContain("***");
  });

  it("fails closed when one nested URL exceeds the percent-encoding bound", () => {
    let nested = joinUrlParts(
      "https://encoded-user",
      ":",
      "encoded-pass",
      "@inner.example/?to",
      "ken=",
      "encoded-token",
    );
    for (let index = 0; index < 20; index += 1) {
      nested = encodeURIComponent(nested);
    }
    const redacted = redactSensitiveUrl(
      `https://outer.example/?next=${encodeURIComponent(nested)}`,
    );
    expect(redacted).not.toContain("encoded-user");
    expect(redacted).not.toContain("encoded-pass");
    expect(redacted).not.toContain("encoded-token");
    expect(redacted).toContain("***");
  });

  it("preserves redaction for valid non-hierarchical URLs", () => {
    const value = joinUrlParts("mailto:user@example.com?to", "ken=", "secret");
    expect(redactSensitiveUrl(value)).toBe(
      joinUrlParts("mailto:user@example.com?to", "ken=", "***"),
    );
  });

  it("redacts embedded credentials in opaque URLs", () => {
    const value = joinUrlParts(
      "data:text/plain,https://opaque-user",
      ":",
      "opaque-pass",
      "@inner.example",
    );
    const redacted = redactSensitiveUrl(value);
    expect(redacted).not.toContain("opaque-user");
    expect(redacted).not.toContain("opaque-pass");
    expect(redacted).toContain("***:***@inner.example");
  });
});

describe("redactSensitiveUrlLikeString", () => {
  it("redacts invalid URL-like strings", () => {
    expect(redactSensitiveUrlLikeString("//user:pass@example.com/mcp?client_secret=secret")).toBe(
      "//***:***@example.com/mcp?client_secret=***",
    );
  });

  it("redacts encoded and invisible-spliced query names in invalid URL-like strings", () => {
    expect(
      redactSensitiveUrlLikeString("//example.com/mcp?client%5Fse%E2%80%8Bcret=secret&safe=value"),
    ).toBe("//example.com/mcp?client%5Fse%E2%80%8Bcret=***&safe=value");
  });

  it("redacts encoded query names with decoded whitespace and control separators in invalid URL-like strings", () => {
    expect(
      redactSensitiveUrlLikeString(
        "//example.com/mcp?client%5Fse%20cret=space&client%5Fse%00cret=nul",
      ),
    ).toBe("//example.com/mcp?client%5Fse%20cret=***&client%5Fse%00cret=***");
  });

  it("redacts plus-spliced query names in invalid URL-like strings", () => {
    expect(redactSensitiveUrlLikeString("//example.com/mcp?client_se+cret=secret&safe=value")).toBe(
      "//example.com/mcp?client_se+cret=***&safe=value",
    );
  });

  it("redacts every URL-like userinfo occurrence in arbitrary text", () => {
    expect(
      redactSensitiveUrlLikeString(
        "fatal https://a:b@github.com/one.git and https://c:d@github.com/two.git",
      ),
    ).toBe("fatal https://***:***@github.com/one.git and https://***:***@github.com/two.git");
  });

  it("redacts protocol URLs that are too malformed to parse", () => {
    expect(
      redactSensitiveUrlLikeString(
        "wss://fallback-user:fallback-pass@[bad-host/socket?token=fallback-secret&keep=visible)",
      ),
    ).toBe("wss://***:***@[bad-host/socket?token=***&keep=visible)");
  });

  it("redacts Telegram bot tokens from URL-like fallback strings", () => {
    expect(
      redactSensitiveUrlLikeString(
        "timeout /bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd/sendMessage and keep /bot/settings",
      ),
    ).toBe("timeout /bot***/sendMessage and keep /bot/settings");
  });
});

describe("isSensitiveUrlQueryParamName", () => {
  it("matches the auth-oriented query params used by MCP SSE config redaction", () => {
    expect(isSensitiveUrlQueryParamName("token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("refresh_token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("access-token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("hook-token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("passwd")).toBe(true);
    expect(isSensitiveUrlQueryParamName("signature")).toBe(true);
    expect(isSensitiveUrlQueryParamName("code")).toBe(true);
    expect(isSensitiveUrlQueryParamName("x-amz-signature")).toBe(true);
    expect(isSensitiveUrlQueryParamName("X-Amz-Security-Token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("id_token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("app_secret")).toBe(true);
    expect(isSensitiveUrlQueryParamName("client%5Fse\u200Bcret")).toBe(true);
    expect(isSensitiveUrlQueryParamName("client%5Fse%20cret")).toBe(true);
    expect(isSensitiveUrlQueryParamName("client%5Fse%00cret")).toBe(true);
    expect(isSensitiveUrlQueryParamName("client_se+cret")).toBe(true);
    expect(isSensitiveUrlQueryParamName("client_se\u3164cret")).toBe(true);
    expect(isSensitiveUrlQueryParamName("credential")).toBe(true);
    expect(isSensitiveUrlQueryParamName("safe")).toBe(false);
  });
});

describe("sensitive URL config metadata", () => {
  it("recognizes config paths that may embed URL secrets", () => {
    expect(isSensitiveUrlConfigPath("models.providers.*.baseUrl")).toBe(true);
    expect(isSensitiveUrlConfigPath("mcp.servers.remote.url")).toBe(true);
    expect(isSensitiveUrlConfigPath("nodeHost.mcp.servers.remote.url")).toBe(true);
    expect(isSensitiveUrlConfigPath("gateway.remote.url")).toBe(false);
  });

  it("recognizes cdpUrl config paths as sensitive (browser CDP URLs can embed credentials)", () => {
    expect(isSensitiveUrlConfigPath("browser.cdpUrl")).toBe(true);
    expect(isSensitiveUrlConfigPath("browser.profiles.remote.cdpUrl")).toBe(true);
    expect(isSensitiveUrlConfigPath("browser.profiles.staging.cdpUrl")).toBe(true);
  });

  it("uses an explicit url-secret hint tag", () => {
    expect(SENSITIVE_URL_HINT_TAG).toBe("url-secret");
    expect(hasSensitiveUrlHintTag({ tags: [SENSITIVE_URL_HINT_TAG] })).toBe(true);
    expect(hasSensitiveUrlHintTag({ tags: ["security"] })).toBe(false);
  });
});

function joinUrlParts(...parts: string[]): string {
  return parts.join("");
}

describe("nested URL-like fallback redaction", () => {
  it("redacts embedded credentials from query parameter names", () => {
    const nestedKey = joinUrlParts("https://key-user", ":", "key-pass", "@inner.example/");
    for (const value of [
      `https://outer.example/?${nestedKey}=value`,
      `https://outer.example/#/cb?${nestedKey}=value`,
    ]) {
      const redacted = redactSensitiveUrlLikeString(value);
      expect(redacted).not.toContain("key-user");
      expect(redacted).not.toContain("key-pass");
      expect(redacted).toContain("***");
    }
  });

  it("redacts encoded reserved characters inside nested userinfo", () => {
    for (const encodedReserved of ["%2F", "%3F", "%23"]) {
      const encodedNested = joinUrlParts(
        "%68%74%74%70%73%3A%2F%2Fencoded-user",
        "%3A",
        `encoded-pass${encodedReserved}part%40inner.example%2F`,
      );
      const redacted = redactSensitiveUrlLikeString(`https://outer.example/proxy/${encodedNested}`);
      expect(redacted).not.toContain("encoded-user");
      expect(redacted).not.toContain("encoded-pass");
      expect(redacted).toContain("***:***@inner.example/");
    }
  });

  it("fails closed for unresolved encoded userinfo delimiters", () => {
    for (const encodedUserInfo of [
      "encoded-user%3Aencoded-pass%20part%40",
      "encoded-user%2Fpart%3Aencoded-pass%40",
      "encoded-user%2Fpart%40",
    ]) {
      const encodedNested = `%68%74%74%70%73%3A%2F%2F${encodedUserInfo}inner.example%2F`;
      const redacted = redactSensitiveUrlLikeString(`https://outer.example/proxy/${encodedNested}`);
      expect(redacted).not.toContain("encoded-user");
      expect(redacted).not.toContain("encoded-pass");
      expect(redacted).toContain("***");
    }
  });

  it("fails closed for unresolved encoded protocol-relative userinfo", () => {
    const value = joinUrlParts("//relative-user%2Fpart%3A", "relative-pass", "%40inner.example");
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("relative-user");
    expect(redacted).not.toContain("relative-pass");
    expect(redacted).toContain("***");
  });

  it("fails closed after a nested query value decodes into ambiguous userinfo", () => {
    const nested = joinUrlParts(
      "https%3A%2F%2Fquery-user%2Fpart%3A",
      "query-pass",
      "%40inner.example%2F",
    );
    const redacted = redactSensitiveUrlLikeString(`https://outer.example/?next=${nested}`);
    expect(redacted).not.toContain("query-user");
    expect(redacted).not.toContain("query-pass");
    expect(redacted).toContain("***");
  });

  it("preserves host ports and IPv6 hosts when later path segments contain an at sign", () => {
    for (const nested of [
      "https://inner.example:443/path@label",
      "https://inner.example:443?email=user@example.com",
      "https://[2001:db8::1]/path@label",
      "https://[2001:db8::1]#user@example.com",
    ]) {
      const value = `https://outer.example/proxy/${nested}`;
      expect(redactSensitiveUrlLikeString(value)).toBe(value);
    }
  });

  it("preserves encoded safe URLs when paths, queries, or fragments contain an at sign", () => {
    const unambiguousEmbeddedUrls = [
      "https://inner.example:443/path@label",
      "https://inner.example:443?email=user@example.com",
      "https://[2001:db8::1]/path@label",
      "https://[2001:db8::1]#user@example.com",
    ];
    const safeUrls = [
      "https://inner.example/path@label",
      "https://inner.example?email=user@example.com",
      "https://inner.example#user@example.com",
      ...unambiguousEmbeddedUrls,
    ];
    for (const nested of safeUrls) {
      const encoded = encodeURIComponent(nested);
      expect(redactSensitiveUrlLikeString(encoded)).toBe(encoded);
      for (const outer of [
        `https://outer.example/proxy/${encoded}`,
        `https://outer.example/?next=${encoded}`,
      ]) {
        expect(redactSensitiveUrlLikeString(outer)).toBe(outer);
      }
    }
  });

  it("redacts embedded URLs when a diagnostic prefix parses as an opaque scheme", () => {
    expect(
      redactSensitiveUrlLikeString(
        joinUrlParts(
          "fatal: retry https://first",
          ":",
          "first-pass",
          "@one.example then https://second",
          ":",
          "second-pass",
          "@two.example",
        ),
      ),
    ).toBe(
      joinUrlParts(
        "fatal: retry https://",
        "***",
        ":",
        "***",
        "@one.example then https://",
        "***",
        ":",
        "***",
        "@two.example",
      ),
    );
  });

  it("redacts a credential-bearing URL embedded in a parsed outer URL path", () => {
    const value = joinUrlParts(
      "https://outer.example/proxy/https://path-user",
      ":",
      "path-pass",
      "@inner.example/",
    );
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("path-user");
    expect(redacted).not.toContain("path-pass");
    expect(redacted).toContain(joinUrlParts("https://", "***", ":", "***", "@inner.example/"));
  });

  it("redacts a percent-encoded credential-bearing URL in an outer URL path", () => {
    const nested = joinUrlParts(
      "https://path-user",
      ":",
      "path-pass",
      "@inner.example/?to",
      "ken=",
      "path-token",
    );
    for (const layers of [1, 2, 20]) {
      let encoded = nested;
      for (let index = 0; index < layers; index += 1) {
        encoded = encodeURIComponent(encoded);
      }
      const redacted = redactSensitiveUrlLikeString(`https://outer.example/proxy/${encoded}`);
      expect(redacted).not.toContain("path-user");
      expect(redacted).not.toContain("path-pass");
      expect(redacted).not.toContain("path-token");
      expect(redacted).toContain("***");
    }
  });

  it("redacts a nested URL in a hash-router query parameter", () => {
    const nested = joinUrlParts("https://inner.example/?access", "_token", "=", "router-secret");
    const value = `https://outer.example/#/cb?next=${nested}&keep=visible`;
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("router-secret");
    expect(redacted).toContain("keep=visible");
  });

  it("fails closed when an encoded fragment also has a malformed escape", () => {
    const value = joinUrlParts(
      "https://outer.example/#access",
      "_token%3D",
      "malformed-secret",
      "%ZZ",
    );
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("malformed-secret");
    expect(redacted).toBe("https://outer.example/#***");
  });

  it("redacts an encoded URL in an otherwise unparsed URL-like string", () => {
    const nested = joinUrlParts(
      "https://fallback-user",
      ":",
      "fallback-pass",
      "@inner.example/?to",
      "ken=",
      "fallback-token",
    );
    const value = `callback=${encodeURIComponent(nested)}`;
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("fallback-user");
    expect(redacted).not.toContain("fallback-pass");
    expect(redacted).not.toContain("fallback-token");
    expect(redacted).toContain("***");
  });

  it("redacts an encoded relative URL fragment in a nested query value", () => {
    const relative = joinUrlParts("callback#access", "_token", "=", "relative-secret");
    const value = `https://outer.example/?next=${encodeURIComponent(relative)}`;
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("relative-secret");
    expect(redacted).toContain("***");
  });

  it("redacts an encoded backslash-form URL authority", () => {
    const nested = joinUrlParts(
      "https:",
      "\\\\",
      "backslash-user",
      ":",
      "backslash-pass",
      "@inner.example/",
    );
    const value = `https://outer.example/?next=${encodeURIComponent(nested)}`;
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("backslash-user");
    expect(redacted).not.toContain("backslash-pass");
    expect(redacted).toContain("***");
  });

  it("redacts special-scheme URLs with omitted authority slashes", () => {
    for (const separator of ["/", ""]) {
      const nested = joinUrlParts(
        "https:",
        separator,
        "short-user",
        ":",
        "short-pass",
        "@inner.example/",
      );
      const value = `https://outer.example/?next=${encodeURIComponent(nested)}`;
      const redacted = redactSensitiveUrlLikeString(value);
      expect(redacted).not.toContain("short-user");
      expect(redacted).not.toContain("short-pass");
      expect(redacted).toContain("***");
    }
  });

  it("redacts slashless special-scheme userinfo embedded in an outer path", () => {
    const nested = joinUrlParts("https:", "path-user", ":", "path-pass", "@inner.example/");
    const redacted = redactSensitiveUrlLikeString(`https://outer.example/proxy/${nested}`);
    expect(redacted).not.toContain("path-user");
    expect(redacted).not.toContain("path-pass");
    expect(redacted).toContain("***");
  });

  it("redacts through the final userinfo delimiter in a protocol-relative URL", () => {
    const nested = joinUrlParts("//first-user@second-user", ":", "multi-pass", "@inner.example/");
    const redacted = redactSensitiveUrlLikeString(`https://outer.example/proxy/${nested}`);
    expect(redacted).not.toContain("first-user");
    expect(redacted).not.toContain("second-user");
    expect(redacted).not.toContain("multi-pass");
    expect(redacted).toContain("***:***@inner.example/");
  });

  it("redacts an ampersand inside embedded URL userinfo", () => {
    const nested = joinUrlParts("https://amp-user", ":", "amp&pass", "@inner.example/");
    const redacted = redactSensitiveUrlLikeString(`https://outer.example/proxy/${nested}`);
    expect(redacted).not.toContain("amp-user");
    expect(redacted).not.toContain("amp&pass");
    expect(redacted).toContain("***:***@inner.example/");
  });

  it("redacts mixed literal and encoded credentials in one URL-like string", () => {
    const literal = joinUrlParts("https://literal-user", ":", "literal-pass", "@one.example/");
    const encoded = encodeURIComponent(
      joinUrlParts("https://encoded-user", ":", "encoded-pass", "@two.example/"),
    );
    const value = `diagnostic ${literal} then ${encoded}`;
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("literal-user");
    expect(redacted).not.toContain("literal-pass");
    expect(redacted).not.toContain("encoded-user");
    expect(redacted).not.toContain("encoded-pass");
  });

  it("redacts mixed literal and encoded credentials in one fragment", () => {
    const literal = joinUrlParts("https://literal-user", ":", "literal-pass", "@one.example/");
    const encoded = encodeURIComponent(
      joinUrlParts("https://encoded-user", ":", "encoded-pass", "@two.example/"),
    );
    const redacted = redactSensitiveUrlLikeString(
      `https://outer.example/#diagnostic ${literal} then ${encoded}`,
    );
    expect(redacted).not.toContain("literal-user");
    expect(redacted).not.toContain("literal-pass");
    expect(redacted).not.toContain("encoded-user");
    expect(redacted).not.toContain("encoded-pass");
  });

  it("redacts an opaque URL whose pathname cannot be assigned", () => {
    const nested = encodeURIComponent(
      joinUrlParts("https://opaque-user", ":", "opaque-pass", "@inner.example/"),
    );
    const redacted = redactSensitiveUrlLikeString(`data:text/plain,${nested}`);
    expect(redacted).not.toContain("opaque-user");
    expect(redacted).not.toContain("opaque-pass");
    expect(redacted).toContain("***:***@inner.example/");
  });

  it("redacts repeatedly encoded sensitive query parameter names", () => {
    for (const layers of [0, 1, 8, 20]) {
      let key = "%74oken";
      for (let index = 0; index < layers; index += 1) {
        key = encodeURIComponent(key);
      }
      const value = `https://example.test/?${key}=encoded-name-secret`;
      const redacted = redactSensitiveUrlLikeString(value);
      expect(redacted).not.toContain("encoded-name-secret");
      expect(redacted).toContain("***");
    }
  });

  it("redacts mixed percent-encoded URL structure with a literal sensitive value", () => {
    const encodedScheme = "%68%74%74%70%73%3A%2F%2Finner.example%2F%3F";
    const value = joinUrlParts(
      "https://outer.example/proxy/",
      encodedScheme,
      "to",
      "ken=",
      "mixed-secret",
    );
    const redacted = redactSensitiveUrlLikeString(value);
    expect(redacted).not.toContain("mixed-secret");
    expect(redacted).toContain("***");
  });

  it("does not consume later query parameters while scanning embedded authorities", () => {
    const value = "https://outer.example/?next=https://inner.example&email=user@example.com";
    expect(redactSensitiveUrlLikeString(value)).toBe(value);
  });
});
