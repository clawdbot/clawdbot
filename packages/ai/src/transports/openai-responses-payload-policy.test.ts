import { describe, expect, it } from "vitest";
import {
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

describe("OpenAI Responses HTTP continuation idle TTL", () => {
  function ttlMsFor(responsesContinuationIdleMinutes: number): number {
    return resolveOpenAIResponsesPayloadPolicy({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      compat: { responsesContinuationIdleMinutes },
    }).httpContinuationIdleTtlMs;
  }

  it("uses the configured minutes directly under the setTimeout overflow bound", () => {
    expect(ttlMsFor(90)).toBe(90 * 60 * 1000);
  });

  it("clamps a value that would overflow setTimeout's max delay (2^31-1 ms) instead of firing almost immediately", () => {
    // A 30-day TTL (43,200 minutes) is a realistic "keep this around for a
    // month" configuration, well past the ~35,791.39-minute point where
    // minutes * 60 * 1000 exceeds Node's signed 32-bit setTimeout delay and
    // gets silently clamped to ~1ms -- the opposite of what was configured.
    const oversizedMinutes = 43_200;
    expect(ttlMsFor(oversizedMinutes)).toBeLessThanOrEqual(2_147_483_647);
    expect(ttlMsFor(oversizedMinutes)).toBe(35_791 * 60 * 1000);
  });
});
