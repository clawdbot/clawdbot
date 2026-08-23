// Qa Lab tests cover live timeout plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";

describe("qa live timeout policy", () => {
  it.each([
    {
      title: "keeps mock lanes on the caller fallback",
      mode: "mock-openai",
      model: "anthropic/claude-sonnet-4-6",
      fallbackModel: "anthropic/claude-opus-4-8",
      expectedTimeoutMs: 30_000,
    },
    {
      title: "uses the higher gpt-5 live floor for openai heavy turns",
      mode: "live-frontier",
      model: "openai/gpt-5.6-luna",
      fallbackModel: "openai/gpt-5.6-luna",
      expectedTimeoutMs: 360_000,
    },
    {
      title: "keeps the standard live floor for other non-anthropic models",
      mode: "live-frontier",
      model: "google/gemini-3-flash",
      fallbackModel: "google/gemini-3-flash",
      expectedTimeoutMs: 120_000,
    },
    {
      title: "uses the anthropic floor for sonnet turns",
      mode: "live-frontier",
      model: "anthropic/claude-sonnet-4-6",
      fallbackModel: "anthropic/claude-opus-4-8",
      expectedTimeoutMs: 180_000,
    },
    {
      title: "uses the anthropic floor for claude-cli sonnet turns",
      mode: "live-frontier",
      model: "claude-cli/claude-sonnet-4-6",
      fallbackModel: "claude-cli/claude-opus-4-8",
      expectedTimeoutMs: 180_000,
    },
    {
      title: "uses the opus floor for claude-cli opus turns",
      mode: "live-frontier",
      model: "claude-cli/claude-opus-4-8",
      fallbackModel: "claude-cli/claude-opus-4-8",
      expectedTimeoutMs: 240_000,
    },
  ] as const)("$title", ({ mode, model, fallbackModel, expectedTimeoutMs }) => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: mode,
          primaryModel: model,
          alternateModel: fallbackModel,
        },
        30_000,
      ),
    ).toBe(expectedTimeoutMs);
  });

  it("uses the opus floor when the switched turn runs on claude opus", () => {
    expect(
      resolveQaLiveTurnTimeoutMs(
        {
          providerMode: "live-frontier",
          primaryModel: "anthropic/claude-sonnet-4-6",
          alternateModel: "anthropic/claude-opus-4-8",
        },
        30_000,
        "anthropic/claude-opus-4-8",
      ),
    ).toBe(240_000);
  });
});
