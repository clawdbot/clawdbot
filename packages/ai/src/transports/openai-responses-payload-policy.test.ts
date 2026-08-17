import { describe, expect, it } from "vitest";
import { resolveOpenAIResponsesServerCompactionPlan } from "./openai-responses-payload-policy.js";

describe("OpenAI Responses compact threshold", () => {
  it.each([
    {
      name: "uses the active runtime cap for the direct Sol route",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      expected: 190_400,
    },
    {
      name: "uses the active runtime cap for the Codex Sol budget",
      model: { contextWindow: 372_000, contextTokens: 272_000 },
      expected: 190_400,
    },
    {
      name: "keeps window-only behavior",
      model: { contextWindow: 400_000 },
      expected: 280_000,
    },
    {
      name: "honors an explicit threshold",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      extraParams: { responsesCompactThreshold: 123_456 },
      expected: 123_456,
    },
    {
      name: "uses the fallback without a known budget",
      model: {},
      expected: 80_000,
    },
  ])("$name", ({ model, extraParams, expected }) => {
    expect(
      resolveOpenAIResponsesServerCompactionPlan(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...model,
        },
        extraParams,
      ).threshold,
    ).toBe(expected);
  });
});
