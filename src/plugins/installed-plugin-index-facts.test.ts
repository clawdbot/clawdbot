import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as installRecordMap from "../config/plugin-install-record-map.js";
import * as safeRegex from "../security/safe-regex.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "./installed-plugin-index-install-records.js";
import { createInstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { finalizePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

function createSnapshot(provider = "shared") {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "alpha", origin: "global" },
      { id: "beta", origin: "global" },
    ],
  });
  snapshot.index.installRecords = {
    alpha: { source: "npm", spec: " alpha@1 ", clawhubTrustReasons: [" reviewed "] },
  };
  for (const plugin of snapshot.index.plugins) {
    plugin.startup.agentHarnesses = ["fixture-runtime"];
    plugin.contributions = {
      channels: ["fixture-channel"],
      channelConfigs: [],
      providers: [provider, provider],
      modelCatalogProviders: [],
      modelSupportPrefixes: ["fixture/"],
      modelSupportPatterns: ["^fixture-model$"],
      autoEnableProviderIds: [],
      commandAliases: [],
      contracts: { speechProviders: [provider] },
    };
  }
  return snapshot;
}

function ownerIds(lookup: ReturnType<typeof createInstalledPluginIndexScopeLookup>, id: string) {
  const ids = new Set<string>();
  lookup.addProviderContributionOwners(ids, [id]);
  return [...ids];
}

afterEach(() => vi.restoreAllMocks());

describe("prepared installed-index readers", () => {
  it("prepares immutable ownership and install records once while preserving policy and caller copies", () => {
    withPluginCache(createPluginCache(), () => {
      const snapshot = finalizePluginMetadataSnapshot(createSnapshot());
      const compile = vi.spyOn(safeRegex, "compileSafeRegex");
      const parse = vi.spyOn(installRecordMap, "parsePluginInstallRecordMap");
      const first = createInstalledPluginIndexScopeLookup(snapshot.index);
      const records = extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index);
      assert(records.alpha);
      records.alpha.spec = "caller-owned";
      records.alpha.clawhubTrustReasons?.push("caller-owned");
      first.addProviderContributionOwners = () => {};
      for (let call = 0; call < 5; call++) {
        const lookup = createInstalledPluginIndexScopeLookup(snapshot.index);
        expect(ownerIds(lookup, " SHARED ")).toEqual(["alpha", "beta"]);
        expect(lookup.canResolveDirectProviderIds(["shared"], new Set())).toBe(false);
        expect(lookup.canResolveDirectProviderIds(["alpha"], new Set())).toBe(true);
        expect(lookup.hasInstalledPluginIds([" ALPHA ", "beta"])).toBe(true);
        expect(lookup.hasInstalledPluginIds(["shared"])).toBe(false);
        expect(lookup.hasShorthandModelOwners(["fixture-model"])).toBe(true);
        expect(lookup.hasShorthandModelOwners(["fixture/anything"])).toBe(true);
        expect(lookup.hasAgentHarnessOwners(["fixture-runtime"])).toBe(true);
        expect(lookup.hasChannelContributionOwners(["fixture-channel"])).toBe(true);
        expect(lookup.hasDirectChannelOwners(["fixture-channel"])).toBe(false);
        expect(extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index)).toEqual({
          alpha: { source: "npm", spec: "alpha@1", clawhubTrustReasons: ["reviewed"] },
        });
      }
      expect.soft(compile).toHaveBeenCalledTimes(2);
      expect.soft(parse).toHaveBeenCalledTimes(1);
      expect(
        isInstalledPluginEnabled(snapshot.index, "alpha", { plugins: { allow: ["alpha"] } }),
      ).toBe(true);
      expect(
        isInstalledPluginEnabled(snapshot.index, "alpha", { plugins: { deny: ["alpha"] } }),
      ).toBe(false);
      expect(isInstalledPluginEnabled(snapshot.index, "missing")).toBe(false);
    });
  });

  it("returns independent accepted surfaces from the immutable ledger", () => {
    const snapshot = createSnapshot();
    assert(snapshot.index.installRecords.alpha);
    snapshot.index.installRecords.alpha.acceptedSurface = {
      channels: ["fixture-channel"],
      providers: [],
      tools: [],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    };
    finalizePluginMetadataSnapshot(snapshot);
    withPluginCache(createPluginCache(), () => {
      const first = extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index);
      assert(first.alpha?.acceptedSurface);
      first.alpha.acceptedSurface!.channels.push("caller-owned");
      delete first.alpha;
      const next = extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index);
      expect(next.alpha?.acceptedSurface?.channels).toEqual(["fixture-channel"]);
      expect(Object.getPrototypeOf(next)).toBeNull();
    });
  });

  it.each([false, true])("rereads mutable nested inputs (frozen shell: %s)", (freezeShell) => {
    withPluginCache(createPluginCache(), () => {
      const snapshot = createSnapshot();
      if (freezeShell) {
        Object.freeze(snapshot.index);
      }
      expect(ownerIds(createInstalledPluginIndexScopeLookup(snapshot.index), "shared")).toEqual([
        "alpha",
        "beta",
      ]);
      expect(extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index).alpha?.spec).toBe(
        "alpha@1",
      );
      for (const plugin of snapshot.index.plugins) {
        plugin.contributions!.providers = ["replacement"];
        plugin.contributions!.contracts = {};
      }
      assert(snapshot.index.installRecords.alpha);
      snapshot.index.installRecords.alpha.spec = "alpha@2";
      expect(ownerIds(createInstalledPluginIndexScopeLookup(snapshot.index), "shared")).toEqual([]);
      expect(
        ownerIds(createInstalledPluginIndexScopeLookup(snapshot.index), "replacement"),
      ).toEqual(["alpha", "beta"]);
      expect(extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index).alpha?.spec).toBe(
        "alpha@2",
      );
    });
  });

  it("keeps operation caches independent and retained lookup callbacks on their original inventory", () => {
    const snapshot = finalizePluginMetadataSnapshot(createSnapshot());
    const cache = createPluginCache();
    const read = () => {
      extractPluginInstallRecordsFromInstalledPluginIndex(snapshot.index);
      return createInstalledPluginIndexScopeLookup(snapshot.index);
    };
    const parse = vi.spyOn(installRecordMap, "parsePluginInstallRecordMap");
    const retained = withPluginCache(cache, read);
    withPluginCache(createPluginCache(), read);
    withPluginCache(cache, read);
    expect(parse).toHaveBeenCalledTimes(2);
    const replacement = finalizePluginMetadataSnapshot(createSnapshot("replacement"));
    const current = withPluginCache(cache, () =>
      createInstalledPluginIndexScopeLookup(replacement.index),
    );
    expect(ownerIds(current, "shared")).toEqual([]);
    expect(ownerIds(current, "replacement")).toEqual(["alpha", "beta"]);
    expect(ownerIds(retained, "shared")).toEqual(["alpha", "beta"]);
    expect(ownerIds(retained, "replacement")).toEqual([]);
  });
});
