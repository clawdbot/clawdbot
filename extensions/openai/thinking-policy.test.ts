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
  it.each(["openclaw", "codex", "auto"])(
    "offers Astra's supported efforts on the %s runtime",
    (runtime) => {
      expect(
        resolveUnifiedOpenAIThinkingProfile("gpt-6-astra", runtime).levels.map((level) => level.id),
      ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    },
  );

  it.each([{ efforts: [] }, { efforts: ["low", "high"] }])(
    "retains Astra account efforts $efforts",
    ({ efforts }) => {
      expect(
        resolveUnifiedOpenAIThinkingProfile("gpt-6-astra", "codex", {
          supportedReasoningEfforts: efforts,
        }).levels.map((level) => level.id),
      ).toEqual(["off", ...efforts]);
    },
  );

  it.each([
    { efforts: ["low", "high", "ultra"], expected: ["off", "low", "high", "ultra"] },
    { efforts: ["low", "high", "max"], expected: ["off", "low", "high", "max"] },
    { efforts: [], expected: ["off"] },
  ])("uses native account efforts without a host transport: $efforts", ({ efforts, expected }) => {
    expect(
      resolveUnifiedOpenAIThinkingProfile("account-model", "codex", {
        supportedReasoningEfforts: efforts,
      }).levels.map((level) => level.id),
    ).toEqual(expected);
  });

  it("keeps native fallback capabilities for a direct OpenAI route", () => {
    expect(
      levelIds({
        api: "openai-responses",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).toContain("ultra");
  });

  it("retains known native capabilities when ChatGPT metadata is incomplete", () => {
    expect(
      levelIds({
        api: "openai-chatgpt-responses",
        efforts: ["low", "high"],
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max", "ultra"]);
  });
});
