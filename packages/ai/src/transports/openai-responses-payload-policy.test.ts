import { describe, expect, it } from "vitest";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesServerCompactionPlan,
} from "./openai-responses-payload-policy.js";

describe("OpenAI Responses compact threshold", () => {
  it.each([
    {
      name: "uses the active runtime cap for the direct Sol route",
      model: { contextWindow: 1_050_000, contextTokens: 272_000 },
      expected: 190_400,
    },
    {
      name: "uses the active runtime cap when the window is only modestly larger",
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

describe("chatgpt responses store policy", () => {
  it("chatgpt responses requires explicit store false on the transport path", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy({
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(policy.explicitStore).toBe(false);

    const payload: Record<string, unknown> = { model: "gpt-5.6-luna" };
    applyOpenAIResponsesPayloadPolicy(payload, policy);
    expect(payload.store).toBe(false);
  });

  it("openclaw chatgpt responses transport also emits store false", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy({
      api: "openclaw-openai-chatgpt-responses-transport",
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(policy.explicitStore).toBe(false);
  });
});
