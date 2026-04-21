import { describe, expect, it, vi } from "vitest";
import { runWithImageModelFallback } from "./model-fallback.js";
import { makeModelFallbackCfg } from "./test-helpers/model-fallback-config-fixture.js";

describe("runWithImageModelFallback provider resolution", () => {
  it("inherits the configured image-model provider for bare override ids", async () => {
    const cfg = makeModelFallbackCfg({
      agents: {
        defaults: {
          imageModel: {
            primary: "openai-codex/gpt-5.4",
            fallbacks: ["openai-codex/gpt-5.4-mini"],
          },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithImageModelFallback({
      cfg,
      modelOverride: "gpt-5.4-mini",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([["openai-codex", "gpt-5.4-mini"]]);
  });

  it("keeps a fully qualified override provider over the configured default", async () => {
    const cfg = makeModelFallbackCfg({
      agents: {
        defaults: {
          imageModel: {
            primary: "openai-codex/gpt-5.4",
          },
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce("ok");

    const result = await runWithImageModelFallback({
      cfg,
      modelOverride: "google/gemini-3-pro-image",
      run,
    });

    expect(result.result).toBe("ok");
    expect(run.mock.calls).toEqual([["google", "gemini-3-pro-image"]]);
  });
});
