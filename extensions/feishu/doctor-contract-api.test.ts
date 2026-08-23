// Feishu tests cover the doctor contract artifact surface.
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("feishu doctor contract artifact", () => {
  it("exposes registry-shaped streaming alias rules and the config normalizer", () => {
    // The doctor contract registry keeps rules whose path is an array and
    // whose message is a string (coerceLegacyConfigRules); anything else is
    // silently dropped, which would disable the migration for installed builds.
    expect(legacyConfigRules.length).toBeGreaterThan(0);
    for (const rule of legacyConfigRules) {
      expect(Array.isArray(rule.path)).toBe(true);
      expect(typeof rule.message).toBe("string");
    }

    const result = normalizeCompatibilityConfig({
      cfg: { channels: { feishu: { streaming: true } } } as never,
    });
    const feishu = result.config.channels?.feishu as Record<string, unknown>;
    expect(feishu.streaming).toEqual({ mode: "partial" });
    expect(result.changes.length).toBeGreaterThan(0);
  });
});
