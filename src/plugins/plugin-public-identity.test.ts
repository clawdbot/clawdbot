import { afterEach, describe, expect, it, vi } from "vitest";
import * as officialCatalog from "./official-external-plugin-catalog.js";
import { isPubliclyKnownPluginId } from "./plugin-public-identity.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPubliclyKnownPluginId", () => {
  it.each([
    {
      name: "bundled plugins",
      plugin: { id: "bundled-plugin", origin: "bundled" as const },
      expected: true,
    },
    {
      name: "verified official installs",
      plugin: { id: "official-plugin", origin: "global" as const, trustedOfficialInstall: true },
      expected: true,
    },
    {
      name: "official source checkouts with their catalog package",
      plugin: {
        id: "opencode",
        origin: "workspace" as const,
        packageName: "@openclaw/opencode-provider",
      },
      expected: true,
    },
    {
      name: "private packages squatting on an official plugin id",
      plugin: { id: "opencode", origin: "workspace" as const, packageName: "@acme/private" },
      expected: false,
    },
    {
      name: "unknown private plugin ids",
      plugin: { id: "acme-internal-crm", origin: "workspace" as const },
      expected: false,
    },
  ])("classifies $name", ({ plugin, expected }) => {
    expect(isPubliclyKnownPluginId(plugin)).toBe(expected);
  });

  it("never consults the hosted catalog when classifying private plugin identities", () => {
    const hostedCatalog = vi
      .spyOn(officialCatalog, "loadConfiguredHostedOfficialExternalPluginCatalogEntries")
      .mockResolvedValue({
        source: "bundled-fallback",
        entries: [{ id: "acme-internal-crm", name: "@acme/internal-crm" }],
        error: "hosted fixture",
      });

    expect(
      isPubliclyKnownPluginId({
        id: "acme-internal-crm",
        origin: "global",
        packageName: "@acme/internal-crm",
      }),
    ).toBe(false);
    expect(hostedCatalog).not.toHaveBeenCalled();
  });
});
