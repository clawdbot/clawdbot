import { describe, expect, it } from "vitest";
import { applyCompactionDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";

function materializeCompactionConfig(
  compaction: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["compaction"],
) {
  const cfg = applyCompactionDefaults({
    agents: {
      defaults: {
        compaction,
      },
    },
  });
  return cfg.agents?.defaults?.compaction;
}

describe("config compaction settings", () => {
  it("preserves memory flush config values", () => {
    const compaction = materializeCompactionConfig({
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
      maxActiveTranscriptBytes: "20mb",
    });

    expect(compaction?.reserveTokensFloor).toBe(12_345);
    expect(compaction?.mode).toBe("safeguard");
    expect(compaction?.reserveTokens).toBeUndefined();
    expect(compaction?.keepRecentTokens).toBeUndefined();
    expect(compaction?.identifierPolicy).toBe("custom");
    expect(compaction?.identifierInstructions).toBe("Keep ticket IDs unchanged.");
    expect(compaction?.qualityGuard?.enabled).toBe(true);
    expect(compaction?.qualityGuard?.maxRetries).toBe(2);
    expect(compaction?.memoryFlush?.enabled).toBe(false);
    expect(compaction?.memoryFlush?.softThresholdTokens).toBe(1234);
    expect(compaction?.memoryFlush?.prompt).toBe("Write notes.");
    expect(compaction?.memoryFlush?.systemPrompt).toBe("Flush memory now.");
    expect(compaction?.maxActiveTranscriptBytes).toBe("20mb");
  });

  it("preserves pi compaction override values", () => {
    const compaction = materializeCompactionConfig({
      reserveTokens: 15_000,
      keepRecentTokens: 12_000,
    });

    expect(compaction?.reserveTokens).toBe(15_000);
    expect(compaction?.keepRecentTokens).toBe(12_000);
  });

  it("defaults compaction mode to safeguard", () => {
    const compaction = materializeCompactionConfig({
      reserveTokensFloor: 9000,
    });

    expect(compaction?.mode).toBe("safeguard");
    expect(compaction?.reserveTokensFloor).toBe(9000);
  });

  it("preserves recent turn safeguard values during materialization", () => {
    const compaction = materializeCompactionConfig({
      mode: "safeguard",
      recentTurnsPreserve: 4,
    });

    expect(compaction?.recentTurnsPreserve).toBe(4);
  });

  it("preserves oversized quality guard retry values for runtime clamping", () => {
    const compaction = materializeCompactionConfig({
      qualityGuard: {
        maxRetries: 99,
      },
    });

    expect(compaction?.qualityGuard?.maxRetries).toBe(99);
  });
});
