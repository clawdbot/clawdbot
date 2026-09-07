import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { listRecoveredManagedNpmInstallCandidates } from "./installed-plugin-index-record-reader.js";
import {
  cleanupRetainedManagedNpmInstallGenerations,
  hasRetainedManagedNpmInstallMarker,
} from "./managed-npm-retention.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

function npmRecord(packageName: string, installPath: string): PluginInstallRecord {
  return { source: "npm", spec: `${packageName}@1.0.0`, installPath };
}

describe("retained managed npm record commits", () => {
  it("suppresses recovery when a retained install record is removed", async () => {
    await withOpenClawTestState({ label: "retained-record-removal" }, async (state) => {
      const packageName = "@openclaw/retained-demo";
      const installPath = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName,
        pluginId: "retained-demo",
        version: "1.0.0",
      });
      expect(
        listRecoveredManagedNpmInstallCandidates({ stateDir: state.stateDir }).map(
          (candidate) => candidate.pluginId,
        ),
      ).toContain("retained-demo");

      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: { "retained-demo": npmRecord(packageName, installPath) },
        nextInstallRecords: {},
        nextConfig: {},
      });

      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(true);
      expect(
        listRecoveredManagedNpmInstallCandidates({ stateDir: state.stateDir }).map(
          (candidate) => candidate.pluginId,
        ),
      ).not.toContain("retained-demo");
    });
  });

  it.each(["direct", "symlink"] as const)(
    "does not retire a package still used by a %s active install path",
    async (activePathKind) => {
      await withOpenClawTestState({ label: `retained-active-${activePathKind}` }, async (state) => {
        const packageName = "@openclaw/retained-active";
        const installPath = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName,
          pluginId: "retained-active",
          version: "1.0.0",
        });
        let activePath = installPath;
        if (activePathKind === "symlink") {
          activePath = state.statePath("active", "retained-active");
          fs.mkdirSync(path.dirname(activePath), { recursive: true });
          fs.symlinkSync(installPath, activePath, "dir");
        }

        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: { "retained-active": npmRecord(packageName, installPath) },
          nextInstallRecords: {
            "retained-active": {
              source: "path",
              sourcePath: activePath,
              installPath: activePath,
            },
          },
          nextConfig: {},
        });

        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
        expect(fs.existsSync(activePath)).toBe(true);
      });
    },
  );

  it("does not retire a removed npm record outside the managed npm root", async () => {
    await withOpenClawTestState({ label: "retained-outside-root" }, async (state) => {
      const outsideRoot = state.path("outside-root");
      try {
        const packageName = "@openclaw/outside-retained";
        const installPath = writeManagedNpmPlugin({
          stateDir: outsideRoot,
          packageName,
          pluginId: "outside-retained",
          version: "1.0.0",
        });
        await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: { "outside-retained": npmRecord(packageName, installPath) },
          nextInstallRecords: {},
          nextConfig: {},
        });
        expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(false);
      } finally {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it("keeps npm-to-local source changes cleanup-eligible", async () => {
    await withOpenClawTestState({ label: "retained-source-change" }, async (state) => {
      const packageName = "@openclaw/moved-local";
      const installPath = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName,
        pluginId: "moved-local",
        version: "1.0.0",
      });
      const localInstallPath = state.statePath("extensions", "moved-local");
      fs.mkdirSync(localInstallPath, { recursive: true });

      await commitPluginInstallRecordsWithConfig({
        previousInstallRecords: { "moved-local": npmRecord(packageName, installPath) },
        nextInstallRecords: {
          "moved-local": {
            source: "path",
            sourcePath: localInstallPath,
            installPath: localInstallPath,
          },
        },
        nextConfig: {},
      });

      expect(hasRetainedManagedNpmInstallMarker(installPath)).toBe(true);
      await expect(
        cleanupRetainedManagedNpmInstallGenerations({
          activeInstallPaths: [localInstallPath],
        }),
      ).resolves.toBe(1);
      expect(fs.existsSync(installPath)).toBe(false);
      expect(fs.existsSync(localInstallPath)).toBe(true);
    });
  });
});
