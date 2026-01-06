import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveConfiguredModelRef } from "./model-selection.js";

describe("resolveConfiguredModelRef", () => {
  it("parses provider/model from agent.model.primary", () => {
    const cfg = {
      agent: { model: { primary: "openai/gpt-4.1-mini" } },
    } satisfies ClawdbotConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
  });

  it("falls back to anthropic when agent.model.primary omits provider", () => {
    const cfg = {
      agent: { model: { primary: "claude-opus-4-5" } },
    } satisfies ClawdbotConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("falls back to defaults when agent.model is missing", () => {
    const cfg = {} satisfies ClawdbotConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
    });
  });

  it("resolves agent.model aliases when configured", () => {
    const cfg = {
      agent: {
        model: { primary: "Opus" },
        models: {
          "anthropic/claude-opus-4-5": { alias: "Opus" },
        },
      },
    } satisfies ClawdbotConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("still resolves legacy agent.model string", () => {
    const cfg = {
      agent: { model: "openai/gpt-4.1-mini" },
    } satisfies ClawdbotConfig;

    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });

    expect(resolved).toEqual({ provider: "openai", model: "gpt-4.1-mini" });
  });
});
