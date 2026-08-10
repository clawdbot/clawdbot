// LongCat tests cover the plugin-owned doctor baseUrl migration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const LEGACY = "https://api.longcat.chat/openai";
const CANONICAL = "https://api.longcat.chat/openai/v1";

function longcatConfig(provider: Record<string, unknown>): OpenClawConfig {
  return { models: { providers: { longcat: provider } } } as unknown as OpenClawConfig;
}

function migratedProvider(cfg: OpenClawConfig): Record<string, unknown> {
  const providers = cfg.models?.providers as Record<string, Record<string, unknown>> | undefined;
  return providers?.longcat ?? {};
}

describe("LongCat doctor contract", () => {
  it("flags only the retired unversioned default baseUrl", () => {
    const rule = legacyConfigRules[0];
    expect(rule?.message).toContain("openclaw doctor --fix");
    expect(rule?.match?.(LEGACY)).toBe(true);
    expect(rule?.match?.(`${LEGACY}/`)).toBe(true);
    expect(rule?.match?.(CANONICAL)).toBe(false);
    expect(rule?.match?.("https://gw.example.com/openai")).toBe(false);
  });

  it("returns the same config when no longcat provider is configured", () => {
    const cfg = { models: { providers: {} } } as OpenClawConfig;
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
    expect(normalizeCompatibilityConfig({ cfg: {} as OpenClawConfig }).changes).toEqual([]);
  });

  it("migrates the exact former default to the documented /openai/v1 endpoint", () => {
    const cfg = longcatConfig({ apiKey: "key", baseUrl: `${LEGACY}/` });
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.changes).toEqual([`models.providers.longcat.baseUrl: ${LEGACY} -> ${CANONICAL}`]);
    expect(migratedProvider(result.config)).toEqual({ apiKey: "key", baseUrl: CANONICAL });
  });

  it("preserves custom endpoints and the already-migrated default", () => {
    for (const baseUrl of [CANONICAL, "https://gw.example.com/openai", "http://localhost:8000"]) {
      const cfg = longcatConfig({ apiKey: "key", baseUrl });
      const result = normalizeCompatibilityConfig({ cfg });
      expect(result.changes).toEqual([]);
      expect(migratedProvider(result.config)).toEqual({ apiKey: "key", baseUrl });
    }
  });
});
