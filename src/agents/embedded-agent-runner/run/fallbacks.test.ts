import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasEmbeddedRunConfiguredModelFallbacks } from "./fallbacks.js";

describe("hasEmbeddedRunConfiguredModelFallbacks", () => {
  it("uses explicit non-empty modelFallbacksOverride as configured", () => {
    expect(
      hasEmbeddedRunConfiguredModelFallbacks({
        cfg: {},
        modelFallbacksOverride: ["openai/gpt-5.4"],
      }),
    ).toBe(true);
  });

  it("treats explicit empty modelFallbacksOverride as disabling fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
      },
    };
    expect(
      hasEmbeddedRunConfiguredModelFallbacks({
        cfg,
        modelFallbacksOverride: [],
      }),
    ).toBe(false);
  });

  it("falls back to normal agent/default model fallback config when no override is provided", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
      },
    };
    expect(hasEmbeddedRunConfiguredModelFallbacks({ cfg, agentId: "main" })).toBe(true);
  });
});
