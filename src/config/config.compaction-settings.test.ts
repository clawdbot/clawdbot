import { describe, expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";
import { OpenClawSchema } from "./zod-schema.js";

function parseConfig(config: unknown): OpenClawConfig {
  const result = OpenClawSchema.safeParse(config);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected config to parse");
  }
  return result.data as OpenClawConfig;
}

function parseConfigWithCompactionDefaults(config: unknown): OpenClawConfig {
  return applyCompactionDefaults(parseConfig(config));
}

describe("config compaction settings", () => {
  it("preserves memory flush config values", async () => {
    const cfg = parseConfig({
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            reserveTokensFloor: 12_345,
            identifierPolicy: "custom",
            identifierInstructions: "Keep ticket IDs unchanged.",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
            memoryFlush: {
              enabled: false,
              softThresholdTokens: 1234,
              prompt: "Write notes.",
              systemPrompt: "Flush memory now.",
            },
          },
        },
      },
    });

    expect(cfg.agents?.defaults?.compaction?.reserveTokensFloor).toBe(12_345);
    expect(cfg.agents?.defaults?.compaction?.mode).toBe("safeguard");
    expect(cfg.agents?.defaults?.compaction?.reserveTokens).toBeUndefined();
    expect(cfg.agents?.defaults?.compaction?.keepRecentTokens).toBeUndefined();
    expect(cfg.agents?.defaults?.compaction?.identifierPolicy).toBe("custom");
    expect(cfg.agents?.defaults?.compaction?.identifierInstructions).toBe(
      "Keep ticket IDs unchanged.",
    );
    expect(cfg.agents?.defaults?.compaction?.qualityGuard?.enabled).toBe(true);
    expect(cfg.agents?.defaults?.compaction?.qualityGuard?.maxRetries).toBe(2);
    expect(cfg.agents?.defaults?.compaction?.memoryFlush?.enabled).toBe(false);
    expect(cfg.agents?.defaults?.compaction?.memoryFlush?.softThresholdTokens).toBe(1234);
    expect(cfg.agents?.defaults?.compaction?.memoryFlush?.prompt).toBe("Write notes.");
    expect(cfg.agents?.defaults?.compaction?.memoryFlush?.systemPrompt).toBe("Flush memory now.");
  });

  it("preserves pi compaction override values", async () => {
    const cfg = parseConfig({
      agents: {
        defaults: {
          compaction: {
            reserveTokens: 15_000,
            keepRecentTokens: 12_000,
          },
        },
      },
    });

    expect(cfg.agents?.defaults?.compaction?.reserveTokens).toBe(15_000);
    expect(cfg.agents?.defaults?.compaction?.keepRecentTokens).toBe(12_000);
  });

  it("defaults compaction mode to safeguard", async () => {
    const cfg = parseConfigWithCompactionDefaults({
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor: 9000,
          },
        },
      },
    });

    expect(cfg.agents?.defaults?.compaction?.mode).toBe("safeguard");
    expect(cfg.agents?.defaults?.compaction?.reserveTokensFloor).toBe(9000);
  });

  it("preserves recent turn safeguard values through schema parsing", async () => {
    const cfg = parseConfig({
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            recentTurnsPreserve: 4,
          },
        },
      },
    });

    expect(cfg.agents?.defaults?.compaction?.recentTurnsPreserve).toBe(4);
  });

  it("preserves oversized quality guard retry values for runtime clamping", async () => {
    const cfg = parseConfig({
      agents: {
        defaults: {
          compaction: {
            qualityGuard: {
              maxRetries: 99,
            },
          },
        },
      },
    });

    expect(cfg.agents?.defaults?.compaction?.qualityGuard?.maxRetries).toBe(99);
  });
});
