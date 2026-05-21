import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  pruneStaleLocalBundledPluginInstallRecords,
} from "./stale-local-bundled-plugin-install-records.js";

function bundledSource(pluginId: string, localPath: string): Map<string, BundledPluginSource> {
  return new Map([
    [
      pluginId,
      {
        pluginId,
        localPath,
        version: "2026.5.20",
      },
    ],
  ]);
}

describe("listStaleLocalBundledPluginInstallRecords", () => {
  it("lists path install records that point at stale compiled bundled output", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");
    const stalePath = path.join("/tmp/old-openclaw", "dist", "extensions", "discord");
    const records: Record<string, PluginInstallRecord> = {
      discord: {
        source: "path",
        installPath: stalePath,
        version: "2026.5.4-beta.3",
      },
      brave: {
        source: "npm",
        installPath: "/tmp/plugins/brave",
      },
    };

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: records,
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual([
      {
        pluginId: "discord",
        record: records.discord,
        recordPathField: "installPath",
        stalePath,
        bundledPath: currentPath,
      },
    ]);
  });

  it("does not list the current bundled path", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: currentPath,
            version: "2026.5.4-beta.3",
          },
        },
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual([]);
  });

  it("does not list compiled bundled paths without a stale version", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: path.join("/tmp/local-openclaw", "dist", "extensions", "discord"),
          },
          acpx: {
            source: "path",
            installPath: path.join("/tmp/local-openclaw", "dist", "extensions", "acpx"),
            version: "2026.5.20",
          },
        },
        bundled: new Map([
          ...bundledSource("discord", currentPath),
          ...bundledSource("acpx", path.join("/opt/openclaw", "dist", "extensions", "acpx")),
        ]),
      }),
    ).toStrictEqual([]);
  });

  it("does not list source checkout or arbitrary local plugin paths", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: path.join("/tmp/openclaw", "extensions", "discord"),
            version: "2026.5.4-beta.3",
          },
          acpx: {
            source: "path",
            installPath: path.join("/tmp/custom-plugins", "acpx"),
            version: "2026.5.4-beta.3",
          },
        },
        bundled: new Map([
          ...bundledSource("discord", currentPath),
          ...bundledSource("acpx", path.join("/opt/openclaw", "dist", "extensions", "acpx")),
        ]),
      }),
    ).toStrictEqual([]);
  });
});

describe("pruneStaleLocalBundledPluginInstallRecords", () => {
  it("removes only stale local bundled plugin install records", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");
    const stalePath = path.join("/tmp/old-openclaw", "dist", "extensions", "discord");
    const records: Record<string, PluginInstallRecord> = {
      discord: {
        source: "path",
        installPath: stalePath,
        version: "2026.5.4-beta.3",
      },
      brave: {
        source: "npm",
        installPath: "/tmp/plugins/brave",
      },
    };

    expect(
      pruneStaleLocalBundledPluginInstallRecords({
        installRecords: records,
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual({
      records: {
        brave: records.brave,
      },
      stale: [
        {
          pluginId: "discord",
          record: records.discord,
          recordPathField: "installPath",
          stalePath,
          bundledPath: currentPath,
        },
      ],
    });
  });
});
