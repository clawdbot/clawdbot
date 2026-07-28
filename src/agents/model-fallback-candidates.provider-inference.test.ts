import { describe, expect, it } from "vitest";
// Tests that a bare fallback model id infers its provider from the configured models
// (matching the auth/selection path) instead of inheriting the primary's provider.
import type { OpenClawConfig } from "../config/config.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";

const cfg = {
  models: {
    providers: {
      anthropic: { models: [{ id: "claude-opus-4-6" }] },
      openai: { models: [{ id: "gpt-5.4" }] },
    },
  },
} as unknown as OpenClawConfig;

function fallbackProvider(fallbacks: string[], model: string): string | undefined {
  const chain = resolveModelCandidateChain({
    cfg,
    provider: "anthropic",
    model: "claude-opus-4-6",
    fallbacksOverride: fallbacks,
  });
  return chain.find((c) => c.model === model)?.provider;
}

describe("resolveModelCandidateChain bare fallback provider inference", () => {
  it("infers a bare fallback id's provider from configured models, not the primary's provider", () => {
    // openai/gpt-5.4 is configured; a bare "gpt-5.4" fallback under an anthropic primary must
    // route to openai, not the dead route anthropic/gpt-5.4.
    expect(fallbackProvider(["gpt-5.4"], "gpt-5.4")).toBe("openai");
  });

  it("leaves a slash-qualified fallback unchanged", () => {
    expect(fallbackProvider(["openai/gpt-5.4"], "gpt-5.4")).toBe("openai");
  });

  it("keeps the default (primary) provider for a bare fallback not uniquely configured", () => {
    expect(fallbackProvider(["mystery-model"], "mystery-model")).toBe("anthropic");
  });

  it("keeps the default provider for a bare id configured under multiple providers (not unique)", () => {
    const multiCfg = {
      models: {
        providers: {
          openai: { models: [{ id: "gpt-5.4" }] },
          azure: { models: [{ id: "gpt-5.4" }] },
        },
      },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
    } as unknown as OpenClawConfig;
    const chain = resolveModelCandidateChain({
      cfg: multiCfg,
      provider: "anthropic",
      model: "claude-opus-4-6",
      fallbacksOverride: ["gpt-5.4"],
    });
    // Configured under two providers => inference is not unique => default (primary) preserved.
    expect(chain.find((c) => c.model === "gpt-5.4")?.provider).toBe("anthropic");
  });
});
