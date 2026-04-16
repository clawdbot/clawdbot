import { describe, expect, it } from "vitest";
import { isOpenAIApiBaseUrl, isOpenAICodexBaseUrl } from "./base-url.js";

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
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1")).toBe(true);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v1/")).toBe(true);
  });

  it("rejects non-Codex backend routes", () => {
    expect(isOpenAICodexBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/v2")).toBe(false);
    expect(isOpenAICodexBaseUrl("https://chatgpt.com/backend-api/codex")).toBe(false);
    expect(isOpenAICodexBaseUrl(undefined)).toBe(false);
  });
});
