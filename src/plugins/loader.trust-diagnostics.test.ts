import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { maybeRepairPluginRegistryState } from "../commands/doctor-plugin-registry.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { writePersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { buildPluginInspectReport, buildPluginSnapshotReport } from "./status.js";

const pluginId = "diagnostics-otel";
const packageName = `@openclaw/${pluginId}`;

afterEach(() => {
  resetPluginStateStoreForTests();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("recorded plugin trust diagnostics", () => {
  it.each([
    { name: "legacy npm spec", override: {}, reason: "trusted-official", trusted: true },
    {
      name: "legacy ClawHub spec",
      override: { source: "clawhub", spec: `clawhub:${packageName}@2026.8.2` },
      reason: "provenance-missing",
      trusted: false,
      repair: true,
    },
    { name: "missing record", missing: true, reason: "record-missing", trusted: false },
    { name: "path install", override: { source: "path" }, reason: "origin-path", trusted: false },
    {
      name: "missing provenance",
      override: { spec: undefined },
      reason: "provenance-missing",
      trusted: false,
    },
    {
      name: "conflicting identity",
      override: { resolvedName: "@vendor/diffs" },
      reason: "provenance-invalid",
      trusted: false,
    },
    {
      name: "local npm archive",
      override: { artifactKind: "npm-pack" },
      reason: "origin-path",
      trusted: false,
    },
  ] satisfies Array<{
    name: string;
    override?: Partial<PluginInstallRecord>;
    missing?: boolean;
    reason: string;
    trusted: boolean;
    repair?: boolean;
  }>)(
    "inspection and registration agree for $name",
    async ({ override, missing, reason, trusted, repair }) => {
      useNoBundledPlugins();
      const stateDir = fs.realpathSync(makePluginLoaderTempDir());
      const plugin = writePlugin({
        id: pluginId,
        dir: path.join(stateDir, "extensions", pluginId),
        filename: "index.cjs",
        body: `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) { api.runtime.state.openKeyedStore({ namespace: "proof", maxEntries: 2 }); } };`,
      });
      writePluginMetadata({
        dir: plugin.dir,
        id: plugin.id,
        packageJson: {
          name: packageName,
          version: "2026.8.2",
          openclaw: { extensions: ["./index.cjs"] },
        },
      });
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const install: PluginInstallRecord = {
          source: "npm",
          spec: `${packageName}@2026.8.2`,
          installPath: plugin.dir,
          ...override,
        };
        writePersistedInstalledPluginIndexInstallRecordsSync(
          missing ? {} : { [pluginId]: install },
        );
        const config = {
          plugins: {
            allow: [plugin.id],
            entries: { [plugin.id]: { enabled: true } },
            slots: { memory: "none" },
          },
        };
        const snapshot = buildPluginSnapshotReport({ config });
        const inspected = buildPluginInspectReport({
          id: plugin.id,
          config,
          report: snapshot,
        })!.plugin;
        const registry = loadOpenClawPlugins({ config, cache: false });
        const loaded = registry.plugins.find((entry) => entry.id === plugin.id)!;
        expect(inspected.trustedOfficialInstall === true).toBe(trusted);
        expect(loaded.trustedOfficialInstall === true).toBe(trusted);
        expect(inspected.trust).toEqual(loaded.trust);
        expect(loaded.trust).toMatchObject({
          reason,
          registryPath: path.join(stateDir, "state", "openclaw.sqlite"),
          origin: "global",
        });
        expect(loaded.status).toBe(trusted ? "loaded" : "error");
        if (!trusted) {
          expect(loaded.error).toContain(`reason=${reason}`);
          expect(loaded.error).toContain(
            `registryPath=${JSON.stringify(path.join(stateDir, "state", "openclaw.sqlite"))}`,
          );
          expect(loaded.error).toContain(
            `installSource=${JSON.stringify(missing ? null : install.source)}`,
          );
          expect(loaded.error).toContain(
            `installSpec=${JSON.stringify(missing ? null : (install.spec ?? null))}`,
          );
        }
        if (repair) {
          await maybeRepairPluginRegistryState({
            config,
            stateDir,
            prompter: { shouldRepair: true },
          });
          const repaired = loadOpenClawPlugins({ config, cache: false }).plugins.find(
            (entry) => entry.id === pluginId,
          )!;
          const inspectedAfter = buildPluginSnapshotReport({ config }).plugins.find(
            (entry) => entry.id === pluginId,
          )!;
          expect(repaired).toMatchObject({
            status: "loaded",
            trustedOfficialInstall: true,
            trust: { reason: "trusted-official" },
          });
          expect(inspectedAfter.trust).toEqual(repaired.trust);
        }
      });
    },
  );
});
