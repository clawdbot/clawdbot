import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ANTHROPIC_OPUS_5_CONTEXT_TOKENS, resolveContextTokensForModel } from "./context.js";

const OPUS_5_PROVIDERS = ["anthropic", "anthropic-vertex", "claude-cli"] as const;

function opus5Model(contextWindow: number) {
  return {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 128_000,
  };
}

describe("Claude Opus 5 context resolution", () => {
  it.each(OPUS_5_PROVIDERS)("returns the fixed context for unconfigured %s", (provider) => {
    expect(
      resolveContextTokensForModel({
        provider,
        model: "claude-opus-5",
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      }),
    ).toBe(ANTHROPIC_OPUS_5_CONTEXT_TOKENS);
  });

  it.each(OPUS_5_PROVIDERS)("ignores a materialized lower %s window", (provider) => {
    const cfg = {
      models: {
        providers: {
          [provider]: {
            baseUrl: "https://api.anthropic.com",
            models: [opus5Model(200_000)],
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveContextTokensForModel({
        cfg,
        sourceCfg: {},
        provider,
        model: "claude-opus-5",
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      }),
    ).toBe(ANTHROPIC_OPUS_5_CONTEXT_TOKENS);
  });

  it("does not classify claude-opus-50 as Opus 5", () => {
    expect(
      resolveContextTokensForModel({
        provider: "anthropic",
        model: "claude-opus-50",
        fallbackContextTokens: 200_000,
        allowAsyncLoad: false,
      }),
    ).toBe(200_000);
  });
});
