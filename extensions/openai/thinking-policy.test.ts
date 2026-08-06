import { describe, expect, it } from "vitest";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

function levelIds(params: {
  api: "openai-responses" | "openai-chatgpt-responses";
  efforts: string[];
}) {
  return resolveUnifiedOpenAIThinkingProfile(
    "gpt-5.6-sol",
    "codex",
    { supportedReasoningEfforts: params.efforts },
    params.api,
  ).levels.map((level) => level.id);
}

describe("OpenAI thinking route provenance", () => {
  it("keeps native fallback capabilities for a direct OpenAI route", () => {
    expect(
      levelIds({
        api: "openai-responses",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).toContain("ultra");
  });

  it("uses ChatGPT model/list metadata as authoritative", () => {
    expect(
      levelIds({
        api: "openai-chatgpt-responses",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).not.toContain("ultra");
  });
});
