import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride } from "../config/test-helpers.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { isTrustedOfficialPluginInstallRecord } from "../plugins/official-external-install-records.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { maybeRepairPluginRegistryState } from "./doctor-plugin-registry.js";
import {
  createCurrentIndex,
  hermeticEnv,
  readRequiredPersistedInstalledPluginIndex,
} from "./doctor-plugin-registry.test-support.js";
import { importShippedPluginInstallConfigForDoctor } from "./doctor/shared/plugin-registry-migration.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const tempDirs: string[] = [];
const pluginId = "diagnostics-otel";
const packageName = "@openclaw/diagnostics-otel";
const legacyRecord: PluginInstallRecord = {
  source: "clawhub",
  spec: `clawhub:${packageName}@2026.7.2`,
};

afterEach(() => {
  vi.mocked(note).mockReset();
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor official plugin provenance", () => {
  it.each(["persisted", "legacy-config"] as const)(
    "persists missing ClawHub authority from a proven official %s record",
    async (source) => {
      const stateDir = makeTrackedTempDir("openclaw-doctor-provenance", tempDirs);
      const installRecords = { [pluginId]: legacyRecord };
      const config = source === "legacy-config" ? { plugins: { installs: installRecords } } : {};
      if (source === "persisted") {
        await writePersistedInstalledPluginIndex(
          { ...createCurrentIndex(), installRecords },
          { stateDir },
        );
      } else {
        const configPath = path.join(stateDir, "openclaw.json");
        fs.writeFileSync(configPath, JSON.stringify(config));
        await withEnvOverride(
          {
            ...hermeticEnv(),
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
          async () => {
            await importShippedPluginInstallConfigForDoctor(await readConfigFileSnapshot());
          },
        );
      }
      expect(
        isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record: legacyRecord }),
      ).toBe(false);

      await maybeRepairPluginRegistryState({
        stateDir,
        candidates: [],
        env: hermeticEnv(),
        config: {},
        prompter: { shouldRepair: true },
      });

      const persisted = await readRequiredPersistedInstalledPluginIndex(stateDir);
      const record = persisted.installRecords[pluginId]!;
      expect(record).toEqual({
        ...legacyRecord,
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
      });
      expect(isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record })).toBe(true);

      await maybeRepairPluginRegistryState({
        stateDir,
        candidates: [],
        env: hermeticEnv(),
        config: {},
        prompter: { shouldRepair: true },
      });
      expect((await readRequiredPersistedInstalledPluginIndex(stateDir)).installRecords).toEqual(
        persisted.installRecords,
      );
    },
  );

  it.each([
    { name: "path source", record: { ...legacyRecord, source: "path" } },
    { name: "local source path", record: { ...legacyRecord, sourcePath: "/tmp/local-plugin" } },
    { name: "missing URL only", record: { ...legacyRecord, clawhubChannel: "official" } },
    { name: "missing channel only", record: { ...legacyRecord, clawhubUrl: "https://clawhub.ai" } },
    { name: "custom host", record: { ...legacyRecord, clawhubUrl: "https://example.invalid" } },
    { name: "community channel", record: { ...legacyRecord, clawhubChannel: "community" } },
    { name: "conflicting identity", record: { ...legacyRecord, resolvedName: "@vendor/acpx" } },
    { name: "package identity alone", record: { source: "clawhub", clawhubPackage: packageName } },
    {
      name: "npm-only catalog identity",
      record: { source: "clawhub", spec: "clawhub:@openclaw/acpx" },
    },
    { name: "unlisted spec", record: { source: "clawhub", spec: "clawhub:@vendor/acpx" } },
    {
      name: "local npm archive",
      record: { source: "npm", spec: packageName, artifactKind: "npm-pack" },
    },
    {
      name: "local npm source path",
      record: { source: "npm", spec: packageName, sourcePath: "/tmp/local-plugin" },
    },
  ] satisfies Array<{ name: string; record: PluginInstallRecord }>)(
    "preserves unproven $name for reinstall instead of inventing authority",
    async ({ record }) => {
      const stateDir = makeTrackedTempDir("openclaw-doctor-provenance", tempDirs);
      const installRecords = { [pluginId]: record };
      await writePersistedInstalledPluginIndex(
        { ...createCurrentIndex(), installRecords },
        { stateDir },
      );
      await maybeRepairPluginRegistryState({
        stateDir,
        candidates: [],
        env: hermeticEnv(),
        config: {},
        prompter: { shouldRepair: true },
      });
      expect((await readRequiredPersistedInstalledPluginIndex(stateDir)).installRecords).toEqual(
        installRecords,
      );
    },
  );

  it("leaves legacy authority untouched without repair", async () => {
    const stateDir = makeTrackedTempDir("openclaw-doctor-provenance", tempDirs);
    const installRecords = { [pluginId]: legacyRecord };
    await writePersistedInstalledPluginIndex(
      { ...createCurrentIndex(), installRecords },
      { stateDir },
    );
    await maybeRepairPluginRegistryState({
      stateDir,
      candidates: [],
      env: hermeticEnv(),
      config: {},
      prompter: { shouldRepair: false },
    });
    expect((await readRequiredPersistedInstalledPluginIndex(stateDir)).installRecords).toEqual(
      installRecords,
    );
  });
});
