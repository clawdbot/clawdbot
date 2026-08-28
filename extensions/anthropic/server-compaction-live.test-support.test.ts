import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_COMPACTION_LIVE_ENV,
  buildAnthropicCompactionContextChunk,
  resolveAnthropicCompactionLiveSettings,
} from "./server-compaction-live.test-support.js";

describe("Anthropic compaction live settings", () => {
  it("stays disabled unless the dedicated spend gate is enabled", () => {
    expect(resolveAnthropicCompactionLiveSettings({}, true)).toEqual({ enabled: false });
  });

  it("requires the global live gate and an API key", () => {
    expect(() =>
      resolveAnthropicCompactionLiveSettings({ [ANTHROPIC_COMPACTION_LIVE_ENV]: "1" }, false),
    ).toThrow("also requires OPENCLAW_LIVE_TEST=1");
    expect(() =>
      resolveAnthropicCompactionLiveSettings({ [ANTHROPIC_COMPACTION_LIVE_ENV]: "1" }, true),
    ).toThrow("requires ANTHROPIC_API_KEY");
  });

  it("builds the bounded reduced live profile", () => {
    const settings = resolveAnthropicCompactionLiveSettings(
      {
        [ANTHROPIC_COMPACTION_LIVE_ENV]: "1",
        ANTHROPIC_API_KEY: "test-key",
      },
      true,
    );

    expect(settings).toMatchObject({
      enabled: true,
      modelId: "claude-sonnet-4-6",
      compactThreshold: 50_000,
      maxDenseTurns: 3,
    });
    expect(buildAnthropicCompactionContextChunk(500)).toHaveLength(500);
  });
});
