import { describe, expect, it } from "vitest";
import {
  canonicalizeCodexResponsesBaseUrl,
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";

describe("openai base URL helpers", () => {
  it("recognizes direct OpenAI API routes", () => {
    expect(isOpenAIApiBaseUrl("https://api.openai.com")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isOpenAIApiBaseUrl("https://api.openai.com/v1/")).toBe(true);
  });

  it("rejects proxy or unrelated API routes", () => {
    expect(isOpenAIApiBaseUrl("https://proxy.example.com/v1")).toBe(false);
    expect(isOpenAIApiBaseUrl("https://chatgpt.com/backend-api")).toBe(false);
    expect(isOpenAIApiBaseUrl(undefined)).toBe(false);
  });

  it("recognizes Codex ChatGPT backend routes", () => {
    // New canonical form (includes /codex segment; OpenAI removed the
    // /backend-api/responses alias server-side on 2026-04).
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v1")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex/v1/")).toBe(true);
    // Legacy form still recognized as a Codex baseURL for backward
    // compatibility with existing user configs.
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1/")).toBe(true);
  });

  it("rejects non-Codex backend routes", () => {
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
    expect(canonicalizeCodexResponsesBaseUrl("https://proxy.example.com/v1")).toBe(
      "https://proxy.example.com/v1",
    );
    expect(canonicalizeCodexResponsesBaseUrl(undefined)).toBeUndefined();
  });
});
