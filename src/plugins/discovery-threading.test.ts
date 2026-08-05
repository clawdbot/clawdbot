// Covers plugin discovery threading and concurrency behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDiscoveryResult } from "./discovery.js";
import * as installedPluginIndexRecordReader from "./installed-plugin-index-record-reader.js";

const discoverOpenClawPluginsMock = vi.fn();

vi.mock("./discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discovery.js")>();
  return {
    ...actual,
    discoverOpenClawPlugins: (...args: unknown[]) => discoverOpenClawPluginsMock(...args),
  };
});

const { loadPluginManifestRegistry } = await import("./manifest-registry.js");
const { loadInstalledPluginIndexWithDiscovery } = await import("./installed-plugin-index.js");

const emptyDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

describe("discovery threading", () => {
  beforeEach(() => {
    discoverOpenClawPluginsMock.mockReset();
    discoverOpenClawPluginsMock.mockReturnValue(emptyDiscovery);
  });

  it("skips internal discoverOpenClawPlugins when discovery is supplied", () => {
    loadPluginManifestRegistry({ discovery: emptyDiscovery });
    expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();

    discoverOpenClawPluginsMock.mockClear();
    loadInstalledPluginIndexWithDiscovery({ discovery: emptyDiscovery, installRecords: {} });
    expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("calls discoverOpenClawPlugins when neither discovery nor candidates supplied", () => {
    loadPluginManifestRegistry({});
    expect(discoverOpenClawPluginsMock).toHaveBeenCalledTimes(1);

    discoverOpenClawPluginsMock.mockClear();
    loadInstalledPluginIndexWithDiscovery({ installRecords: {} });
    expect(discoverOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("prefers explicit candidates over discovery when both are supplied", () => {
    loadPluginManifestRegistry({ candidates: [], diagnostics: [], discovery: emptyDiscovery });
    expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();

    discoverOpenClawPluginsMock.mockClear();
    loadInstalledPluginIndexWithDiscovery({
      candidates: [],
      discovery: emptyDiscovery,
      installRecords: {},
    });
    expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("preserves explicit candidate diagnostics without loading persisted install records", () => {
    const readInstallRecords = vi.spyOn(
      installedPluginIndexRecordReader,
      "loadInstalledPluginIndexInstallRecordsSync",
    );
    const diagnostics = [{ level: "warn" as const, message: "explicit candidate diagnostic" }];

    const result = loadInstalledPluginIndexWithDiscovery({
      candidates: [],
      diagnostics,
      installRecords: {},
    });

    expect(result.manifestRegistry.diagnostics).toEqual(diagnostics);
    expect(result.discovery).toBeUndefined();
    expect(readInstallRecords).not.toHaveBeenCalled();
    expect(discoverOpenClawPluginsMock).not.toHaveBeenCalled();
  });
});
