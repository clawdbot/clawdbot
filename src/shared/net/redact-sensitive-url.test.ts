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

  it("keeps non-sensitive URLs unchanged", () => {
    expect(redactSensitiveUrl("https://example.com/mcp?safe=value")).toBe(
      "https://example.com/mcp?safe=value",
    );
  });
});

describe("redactSensitiveUrlLikeString", () => {
  it("redacts invalid URL-like strings", () => {
    expect(redactSensitiveUrlLikeString("//user:pass@example.com/mcp?client_secret=secret")).toBe(
      "//***:***@example.com/mcp?client_secret=***",
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
});

describe("isSensitiveUrlQueryParamName", () => {
  it("matches the auth-oriented query params used by MCP SSE config redaction", () => {
    expect(isSensitiveUrlQueryParamName("token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("refresh_token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("access-token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("hook-token")).toBe(true);
    expect(isSensitiveUrlQueryParamName("passwd")).toBe(true);
    expect(isSensitiveUrlQueryParamName("signature")).toBe(true);
    expect(isSensitiveUrlQueryParamName("safe")).toBe(false);
  });
});

describe("sensitive URL config metadata", () => {
  it("recognizes config paths that may embed URL secrets", () => {
    expect(isSensitiveUrlConfigPath("models.providers.*.baseUrl")).toBe(true);
    expect(isSensitiveUrlConfigPath("mcp.servers.remote.url")).toBe(true);
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
