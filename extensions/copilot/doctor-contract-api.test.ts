// Copilot tests cover doctor contract api plugin behavior.
import { describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  sessionRouteStateOwners,
} from "./doctor-contract-api.js";

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

  it("declares exactly one session route state owner for copilot", () => {
    expect(sessionRouteStateOwners).toHaveLength(1);
    const owner = sessionRouteStateOwners[0];
    expect(owner.id).toBe("copilot");
    expect(owner.label).toBe("GitHub Copilot agent runtime");
  });

  it("claims the subscription Copilot providers (matches attempt.ts SUPPORTED_PROVIDERS)", () => {
    const owner = sessionRouteStateOwners[0];
    expect(owner.providerIds).toEqual(["github-copilot"]);
  });

  it("claims the copilot runtime, session key, and auth profile prefix", () => {
    const owner = sessionRouteStateOwners[0];
    expect(owner.runtimeIds).toEqual(["copilot"]);
    expect(owner.cliSessionKeys).toEqual(["copilot"]);
    expect(owner.authProfilePrefixes).toEqual(["github-copilot:"]);
  });
});
