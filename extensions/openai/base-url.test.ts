// Openai tests cover base url plugin behavior.
import { describe, expect, it } from "vitest";
import {
  canonicalizeCodexResponsesBaseUrl,
  classifyOpenAIBaseUrl,
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  isOpenAIHttpsApiBaseUrl,
  OPENAI_API_BASE_URL,
  OPENAI_CODEX_RESPONSES_BASE_URL,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";

describe("openai base URL helpers", () => {
  it("recognizes direct OpenAI API routes", () => {
    expect(isOpenAIApiBaseUrl("http://api.openai.com/v1")).toBe(false);
    expect(isOpenAIApiBaseUrl("https://api.openai.com")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com/v1/")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com:443/v1")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com./v1")).toBe(true);
  });

  it("rejects proxy or unrelated API routes", () => {
    expect(isOpenAIApiBaseUrl("ftp://api.openai.com/v1")).toBe(false);
    expect(isOpenAIApiBaseUrl("https://proxy.example.com/v1")).toBe(false);
    expect(isOpenAIApiBaseUrl("https://chatgpt.com/backend-api")).toBe(false);
    expect(isOpenAIApiBaseUrl(undefined)).toBe(false);
  });

  it("limits native transport hooks to HTTPS official routes", () => {
    expect(isOpenAIHttpsApiBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAIHttpsApiBaseUrl("http://api.openai.com/v1")).toBe(false);
  });

  it("classifies exact HTTPS native endpoints as official", () => {
    expect(classifyOpenAIBaseUrl(undefined)).toBe("unresolved");
    expect(classifyOpenAIBaseUrl("https://api.openai.com/v1")).toBe("platform");
    expect(classifyOpenAIBaseUrl("https://api.openai.com:443/v1")).toBe("platform");
    expect(classifyOpenAIBaseUrl("https://api.openai.com./v1")).toBe("platform");
    expect(classifyOpenAIBaseUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(
      "chatgpt",
    );
    expect(classifyOpenAIBaseUrl("https://proxy.example.test/v1?tenant=one")).toBe("custom");
    for (const invalid of [
      "ftp://api.openai.com/v1",
      "http://api.openai.com/v1",
      "http://chatgpt.com/backend-api/codex",
      "https://api.openai.com:8443/v1",
      "http://api.openai.com:443/v1",
      "https://user@api.openai.com/v1",
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1?proxy=1",
      "https://chatgpt.com/backend-api/codex#fragment",
      "not a URL",
    ]) {
      expect(classifyOpenAIBaseUrl(invalid)).toBe("invalid");
    }
  });

  it("recognizes Codex ChatGPT backend routes", () => {
    // New canonical form (includes /codex segment; OpenAI removed the
    // /backend-api/responses alias server-side on 2026-04).
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(true);
    expect(isOpenAICodexBaseUrl("http://chatgpt.com/backend-api/codex")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v1")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v1/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com:443/backend-api/codex")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com./backend-api/codex")).toBe(true);
    // Legacy form still recognized as a Codex baseURL for backward
    // compatibility with existing user configs.
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1/")).toBe(true);
  });

  it("rejects non-Codex backend routes", () => {
    expect(isOpenAICodexBaseUrl("ftp://chatgpt.com/backend-api/codex")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v2")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v2")).toBe(false);
    expect(isOpenAICodexBaseUrl(undefined)).toBe(false);
  });

  it("canonicalizes legacy Codex Responses base URLs", () => {
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api")).toBe(
      OPENAI_CODEX_RESPONSES_BASE_URL,
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api/v1")).toBe(
      OPENAI_CODEX_RESPONSES_BASE_URL,
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api/codex/v1")).toBe(
      OPENAI_CODEX_RESPONSES_BASE_URL,
    );
    expect(
      canonicalizeCodexResponsesBaseUrl("https://chatgpt.com/backend-api/codex/responses"),
    ).toBe(OPENAI_CODEX_RESPONSES_BASE_URL);
    expect(canonicalizeCodexResponsesBaseUrl("http://chatgpt.com/backend-api/codex")).toBe(
      "http://chatgpt.com/backend-api/codex",
    );
    expect(canonicalizeCodexResponsesBaseUrl("https://proxy.example.com/v1")).toBe(
      "https://proxy.example.com/v1",
    );
    expect(canonicalizeCodexResponsesBaseUrl(undefined)).toBeUndefined();
  });

  it("resolves default API base URL from OPENAI_BASE_URL", () => {
    expect(resolveOpenAIDefaultBaseUrl({})).toBe(OPENAI_API_BASE_URL);
    expect(resolveOpenAIDefaultBaseUrl({ OPENAI_BASE_URL: "   " })).toBe(OPENAI_API_BASE_URL);
    expect(resolveOpenAIDefaultBaseUrl({ OPENAI_BASE_URL: " https://proxy.example/v1 " })).toBe(
      "https://proxy.example/v1",
    );
  });
});
