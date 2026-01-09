import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { runWithModelFallback } from "./model-fallback.js";

describe("runWithModelFallback", () => {
  it("uses fallbacksOverride instead of agents.defaults.model.fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as ClawdbotConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    const res = await runWithModelFallback({
      cfg,
      provider: "anthropic",
      model: "claude-opus-4-5",
      fallbacksOverride: ["openai/gpt-4.1"],
      run: async (provider, model) => {
        calls.push({ provider, model });
        if (provider === "anthropic") {
          throw new Error("primary failed");
        }
        if (provider === "openai" && model === "gpt-4.1") {
          return "ok";
        }
        throw new Error(`unexpected candidate: ${provider}/${model}`);
      },
    });

    expect(res.result).toBe("ok");
    expect(calls).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
      { provider: "openai", model: "gpt-4.1" },
    ]);
  });

  it("treats an empty fallbacksOverride as disabling global fallbacks", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.2"],
          },
        },
      },
    } as ClawdbotConfig;

    const calls: Array<{ provider: string; model: string }> = [];

    await expect(
      runWithModelFallback({
        cfg,
        provider: "anthropic",
        model: "claude-opus-4-5",
        fallbacksOverride: [],
        run: async (provider, model) => {
          calls.push({ provider, model });
          throw new Error("primary failed");
        },
      }),
    ).rejects.toThrow("primary failed");

    expect(calls).toEqual([
      { provider: "anthropic", model: "claude-opus-4-5" },
    ]);
  });
});
