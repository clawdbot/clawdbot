import { describe, expect, it } from "vitest";
import { normalizePluginsConfig } from "./config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  isActivatedManifestOwner,
  isBundledManifestOwner,
  passesManifestOwnerBasePolicy,
} from "./manifest-owner-policy.js";

describe("manifest owner policy", () => {
  it("treats bundled owners as bundled and others as non-bundled", () => {
    expect(isBundledManifestOwner({ origin: "bundled" })).toBe(true);
    expect(isBundledManifestOwner({ origin: "workspace" })).toBe(false);
  });

  it("respects enabled, denylist, explicit disable, and allowlist bounds", () => {
    const normalizedConfig = normalizePluginsConfig({
      enabled: true,
      allow: ["demo"],
      deny: ["blocked"],
      entries: {
        disabled: { enabled: false },
        enabled: { enabled: true },
      },
    });

    expect(
      passesManifestOwnerBasePolicy({
        plugin: { id: "demo" },
        normalizedConfig,
      }),
    ).toBe(true);
    expect(
      passesManifestOwnerBasePolicy({
        plugin: { id: "blocked" },
        normalizedConfig,
      }),
    ).toBe(false);
    expect(
      passesManifestOwnerBasePolicy({
        plugin: { id: "disabled" },
        normalizedConfig,
      }),
    ).toBe(false);

    const explicitlyTrustedDisabledConfig = normalizePluginsConfig({
      enabled: true,
      allow: ["disabled"],
      entries: {
        disabled: { enabled: false },
      },
    });
    expect(
      passesManifestOwnerBasePolicy({
        plugin: { id: "disabled" },
        normalizedConfig: explicitlyTrustedDisabledConfig,
        allowExplicitlyDisabled: true,
      }),
    ).toBe(true);
    expect(
      passesManifestOwnerBasePolicy({
        plugin: { id: "other" },
        normalizedConfig,
      }),
    ).toBe(false);
  });

  it("detects explicit manifest owner trust from allowlist or explicit enablement", () => {
    const allowlistConfig = normalizePluginsConfig({
      allow: ["demo"],
    });
    const entriesConfig = normalizePluginsConfig({
      entries: {
        demo: { enabled: true },
      },
    });

    expect(
      hasExplicitManifestOwnerTrust({
        plugin: { id: "demo" },
        normalizedConfig: allowlistConfig,
      }),
    ).toBe(true);
    expect(
      hasExplicitManifestOwnerTrust({
        plugin: { id: "demo" },
        normalizedConfig: entriesConfig,
      }),
    ).toBe(true);
    expect(
      hasExplicitManifestOwnerTrust({
        plugin: { id: "demo" },
        normalizedConfig: normalizePluginsConfig({}),
      }),
    ).toBe(false);
  });

  it("uses effective activation state for activated manifest owners", () => {
    expect(
      isActivatedManifestOwner({
        plugin: {
          id: "demo",
          origin: "bundled",
          enabledByDefault: true,
        },
        normalizedConfig: normalizePluginsConfig({}),
      }),
    ).toBe(true);

    expect(
      isActivatedManifestOwner({
        plugin: {
          id: "demo",
          origin: "bundled",
          enabledByDefault: true,
        },
        normalizedConfig: normalizePluginsConfig({
          enabled: false,
        }),
      }),
    ).toBe(false);
  });
});
