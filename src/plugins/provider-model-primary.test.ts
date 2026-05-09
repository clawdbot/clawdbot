import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyPrimaryModel } from "./provider-model-primary.js";

describe("applyPrimaryModel", () => {
  it("normalizes retired Gemini allowlist keys before writing the primary", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
          models: {
            "google/gemini-3-pro-preview": {
              alias: "gemini",
              params: { thinking: "high" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyPrimaryModel(cfg, "google/gemini-3-pro-preview");

    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "gemini",
        params: { thinking: "high" },
      },
    });
  });
});
