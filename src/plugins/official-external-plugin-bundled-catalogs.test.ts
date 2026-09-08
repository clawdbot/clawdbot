import { describe, expect, it, vi } from "vitest";
import {
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  isOfficialExternalPluginId,
  listOfficialExternalChannelCatalogEntries,
  listOfficialExternalPluginCatalogEntries,
  listOfficialExternalProviderCatalogEntries,
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
} from "./official-external-plugin-catalog.js";
import type { OfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog.types.js";
import {
  hasOfficialExternalChannelTarget,
  hasOfficialExternalContractTarget,
  hasOfficialExternalProviderTarget,
  hasOfficialExternalWebContractEnvTarget,
  hasOfficialExternalWebSearchTarget,
} from "./official-external-plugin-targets.js";

const fixtures = vi.hoisted(() => {
  // Plugin-lane setup can import the real catalog before this file's JSON mocks.
  vi.resetModules();
  const winner = {
    name: " @fixture/Shared ",
    kind: " plugin ",
    openclaw: {
      plugin: { id: " Shared " },
      channel: { id: "Channel" },
      providers: [{ id: " Model ", aliases: [" Alias "] }],
      contracts: { embeddingProviders: [" Capability "] },
    },
  };
  function targetEntry(id: string, prefix: string): OfficialExternalPluginCatalogEntry {
    return {
      name: `@fixture/${prefix}`,
      kind: "plugin",
      openclaw: {
        plugin: { id },
        channel: {
          id: `${prefix}-channel`,
          label: prefix,
          configuredState: { env: { allOf: [`${prefix}_CHANNEL_KEY`] } },
        },
        providers: [{ id: `${prefix}-model`, envVars: [`${prefix}_MODEL_KEY`] }],
        contracts: {
          embeddingProviders: [`${prefix}-embedding`],
          webFetchProviders: [`${prefix}-web`],
        },
        webSearchProviders: [{ id: `${prefix}-web`, envVars: [`${prefix}_WEB_KEY`] }],
      },
    };
  }
  const rejected = {
    ...targetEntry("SourceFiltered", "rejected"),
    install: { candidates: [{ sourceRef: "unconfigured-source", package: "@fixture/rejected" }] },
  };
  const accepted = {
    name: "@fixture/accepted",
    openclaw: { plugin: { id: "SourceFiltered" } },
    install: { candidates: [{ sourceRef: "public-npm", package: "@fixture/accepted" }] },
  };
  const shadow = targetEntry("Shared", "shadow");
  const pluginShadow = { name: "@fixture/plugin-shadow", openclaw: { plugin: { id: "Shared" } } };
  const otherKind = {
    name: "@fixture/other-kind",
    kind: "channel",
    openclaw: { plugin: { id: "Shared" } },
  };
  const lowercase = { name: "@fixture/shared", openclaw: { plugin: { id: "shared" } } };
  const fallback = { id: "FallbackOnly", name: "@fixture/fallback" };
  const mutable: OfficialExternalPluginCatalogEntry = {
    name: "@fixture/mutable",
    openclaw: { plugin: { id: "Mutable" }, providers: [{ id: "OriginalProvider" }] },
  };
  return {
    winner,
    rejected,
    accepted,
    shadow,
    otherKind,
    lowercase,
    fallback,
    mutable,
    channelCatalog: { entries: [rejected, winner, otherKind] },
    providerCatalog: { entries: [shadow, accepted, lowercase] },
    pluginCatalog: { entries: [pluginShadow, fallback, mutable] },
  };
});

vi.mock("../../scripts/lib/official-external-channel-catalog.json", () => ({
  default: fixtures.channelCatalog,
}));
vi.mock("../../scripts/lib/official-external-provider-catalog.json", () => ({
  default: fixtures.providerCatalog,
}));
vi.mock("../../scripts/lib/official-external-plugin-catalog.json", () => ({
  default: fixtures.pluginCatalog,
}));

describe("bundled official external catalog behavior", () => {
  it("keeps the first matching kind and exact identity across catalog sources", () => {
    expect(listOfficialExternalPluginCatalogEntries()).toEqual([
      fixtures.winner,
      fixtures.otherKind,
      fixtures.accepted,
      fixtures.lowercase,
      fixtures.fallback,
      fixtures.mutable,
    ]);
    expect(getOfficialExternalPluginCatalogEntry("Shared")).toBe(fixtures.winner);
    expect(
      getOfficialExternalPluginCatalogEntryForPackage("@fixture/plugin-shadow"),
    ).toBeUndefined();
  });

  it("rejects unconfigured source references before selecting a duplicate or lookup match", () => {
    expect(getOfficialExternalPluginCatalogEntry("SourceFiltered")).toBe(fixtures.accepted);
    expect(getOfficialExternalPluginCatalogEntry("rejected-model")).toBeUndefined();
    expect(getOfficialExternalPluginCatalogEntryForPackage("@fixture/rejected")).toBeUndefined();
    expect(
      resolveOfficialExternalProviderPluginIds({ providerIds: new Set(["rejected-model"]) }),
    ).toEqual([]);
  });

  it("keeps exact lookup identities separate from lowercase canonical and provider queries", () => {
    expect(getOfficialExternalPluginCatalogEntry(" Shared ")).toBe(fixtures.winner);
    expect(getOfficialExternalPluginCatalogEntry("shared")).toBe(fixtures.lowercase);
    expect(getOfficialExternalPluginCatalogEntry("SHARED")).toBeUndefined();
    expect(getOfficialExternalPluginCatalogEntry(" Alias ")).toBe(fixtures.winner);
    expect(getOfficialExternalPluginCatalogEntry("alias")).toBeUndefined();
    expect(getOfficialExternalPluginCatalogEntryForPackage(" @fixture/Shared ")).toBe(
      fixtures.winner,
    );
    expect(getOfficialExternalPluginCatalogEntryForPackage("@fixture/SHARED")).toBeUndefined();
    expect(isOfficialExternalPluginId(" SHARED ")).toBe(true);
    expect(isOfficialExternalPluginId("Alias")).toBe(false);
    expect(isOfficialExternalPluginId("fallbackonly")).toBe(true);
    expect(getOfficialExternalPluginCatalogEntry("FallbackOnly")).toBeUndefined();
    expect(resolveOfficialExternalProviderPluginIds({ providerIds: new Set([" ALIAS "]) })).toEqual(
      ["Shared"],
    );
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "embeddingProviders",
        providerIds: new Set([" capability "]),
      }),
    ).toEqual(["Shared"]);
  });

  it.each([
    ["plugin", listOfficialExternalPluginCatalogEntries],
    ["channel", listOfficialExternalChannelCatalogEntries],
    ["provider", listOfficialExternalProviderCatalogEntries],
  ] as const)("returns independent %s arrays with shared row identities", (_kind, list) => {
    const first = list();
    const second = list();
    expect(first).not.toBe(second);
    expect(first[0]).toBe(fixtures.winner);
    expect(second[0]).toBe(fixtures.winner);
    first.length = 0;
    expect(list()[0]).toBe(fixtures.winner);
  });

  it("observes mutations to returned rows in later lookups and projections", () => {
    const entry = getOfficialExternalPluginCatalogEntry("Mutable")!;
    const originalName = entry.name;
    const originalManifest = entry.openclaw;
    try {
      entry.name = "@fixture/renamed";
      entry.openclaw = {
        plugin: { id: "Renamed" },
        channel: { id: "RenamedChannel", label: "Renamed" },
      };

      expect(getOfficialExternalPluginCatalogEntry("Mutable")).toBeUndefined();
      expect(getOfficialExternalPluginCatalogEntry("OriginalProvider")).toBeUndefined();
      expect(getOfficialExternalPluginCatalogEntry("Renamed")).toBe(entry);
      expect(getOfficialExternalPluginCatalogEntryForPackage("@fixture/mutable")).toBeUndefined();
      expect(getOfficialExternalPluginCatalogEntryForPackage("@fixture/renamed")).toBe(entry);
      expect(isOfficialExternalPluginId("mutable")).toBe(false);
      expect(isOfficialExternalPluginId("renamed")).toBe(true);
      expect(listOfficialExternalChannelCatalogEntries()).toContain(entry);
      expect(listOfficialExternalProviderCatalogEntries()).not.toContain(entry);
      expect(
        hasOfficialExternalChannelTarget({ config: { channels: { renamedchannel: {} } }, env: {} }),
      ).toBe(true);
      expect(
        hasOfficialExternalProviderTarget({ providerIds: ["OriginalProvider"], env: {} }),
      ).toBe(false);
    } finally {
      entry.name = originalName;
      entry.openclaw = originalManifest;
    }
  });

  it.each(["shadow", "rejected"])(
    "keeps conservative repair targets from the %s row excluded by normal catalog selection",
    (prefix) => {
      expect(getOfficialExternalPluginCatalogEntry(`${prefix}-model`)).toBeUndefined();
      expect(
        hasOfficialExternalProviderTarget({
          providerIds: [` ${prefix.toUpperCase()}-MODEL `],
          env: {},
        }),
      ).toBe(true);
      expect(
        hasOfficialExternalProviderTarget({
          providerIds: [],
          env: { [`${prefix}_MODEL_KEY`]: "key" },
        }),
      ).toBe(true);
      expect(
        hasOfficialExternalContractTarget({
          contract: "embeddingProviders",
          providerIds: [`${prefix}-embedding`],
        }),
      ).toBe(true);
      expect(
        hasOfficialExternalChannelTarget({ config: {}, env: { [`${prefix}_CHANNEL_KEY`]: "key" } }),
      ).toBe(true);
      expect(
        hasOfficialExternalWebContractEnvTarget({
          contract: "webFetchProviders",
          env: { [`${prefix}_WEB_KEY`]: "key" },
        }),
      ).toBe(true);
      expect(hasOfficialExternalWebSearchTarget({ providerId: `${prefix}-web`, env: {} })).toBe(
        true,
      );
    },
  );
});
