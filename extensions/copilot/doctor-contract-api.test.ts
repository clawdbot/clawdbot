// Copilot tests cover doctor contract api plugin behavior.
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

describe("copilot doctor contract", () => {
  it("has no legacy config rules at MVP (no retired fields exist yet)", () => {
    expect(legacyConfigRules).toEqual([]);
  });

  it("normalizeCompatibilityConfig is a structural no-op when no migrations apply", () => {
    const cfg = {
      plugins: {
        entries: { copilot: { enabled: true, config: { pool: { idleTtlMs: 12345 } } } },
      },
    } as unknown as Parameters<typeof normalizeCompatibilityConfig>[0]["cfg"];
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });
});
