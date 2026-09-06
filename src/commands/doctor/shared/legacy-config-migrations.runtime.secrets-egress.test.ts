import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObjectRaw } from "../../../config/validation.js";
import { LEGACY_CONFIG_MIGRATION_RUNTIME_SECRETS_EGRESS } from "./legacy-config-migrations.runtime.secrets-egress.js";

function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  LEGACY_CONFIG_MIGRATION_RUNTIME_SECRETS_EGRESS.apply(raw, changes);
  return { raw, changes };
}

describe("secret egress proxy hostname config migration", () => {
  it("repairs a disabled proxy with an unusable bypass host into a valid config", () => {
    const raw = {
      secrets: { egressProxy: { enabled: false, bypassHosts: ["api.example.com:443"] } },
    };

    expect(validateConfigObjectRaw(raw).ok).toBe(false);
    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "secrets.egressProxy.bypassHosts",
      message: expect.stringContaining("not usable hostnames"),
    });

    const result = applyAll(raw);

    expect(result.raw).toEqual({ secrets: { egressProxy: { enabled: false } } });
    expect(result.changes).toEqual([
      'Removed unusable secrets.egressProxy.bypassHosts entries: "api.example.com:443".',
    ]);
    expect(validateConfigObjectRaw(result.raw).ok).toBe(true);
  });

  it.each(["bypassHosts", "allowedHosts"] as const)(
    "preserves valid %s entries while dropping unusable entries",
    (key) => {
      const raw = {
        secrets: {
          egressProxy: {
            [key]: ["good.example.com", "https://bad.example.com"],
          },
        },
      };

      expect(findLegacyConfigIssues(raw)).toContainEqual({
        path: `secrets.egressProxy.${key}`,
        message: expect.stringContaining("not usable hostnames"),
      });

      const result = applyAll(raw);

      expect(result.raw).toEqual({
        secrets: { egressProxy: { [key]: ["good.example.com"] } },
      });
      expect(result.changes).toEqual([
        `Removed unusable secrets.egressProxy.${key} entries: "https://bad.example.com".`,
      ]);
    },
  );

  it("leaves valid host arrays unchanged without reporting legacy issues", () => {
    const raw = {
      secrets: {
        egressProxy: {
          enabled: false,
          allowedHosts: ["API.example.com.", "127.0.0.1", "API.example.com."],
          bypassHosts: ["good.example.com"],
        },
      },
    };
    const original = structuredClone(raw);

    expect(findLegacyConfigIssues(raw)).toEqual([]);

    const result = applyAll(raw);

    expect(result.raw).toEqual(original);
    expect(result.changes).toEqual([]);
  });

  it("detects and drops non-string host entries without throwing", () => {
    const raw = { secrets: { egressProxy: { bypassHosts: [123] } } };

    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "secrets.egressProxy.bypassHosts",
      message: expect.stringContaining("not usable hostnames"),
    });

    const result = applyAll(raw);

    expect(result.raw).toEqual({ secrets: { egressProxy: {} } });
    expect(result.changes).toEqual([
      "Removed unusable secrets.egressProxy.bypassHosts entries: 123.",
    ]);
  });
});
