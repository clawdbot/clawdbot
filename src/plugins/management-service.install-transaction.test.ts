import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { installManagedPluginSource } from "./management-service.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";

const UPDATE_PLUGIN_ID = "install-transaction-demo";

async function writePluginFixture(rootDir: string, version: string): Promise<void> {
  await fs.mkdir(rootDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(rootDir, "package.json"),
      `${JSON.stringify(
        {
          name: UPDATE_PLUGIN_ID,
          version,
          type: "module",
          openclaw: { extensions: ["./index.js"] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(rootDir, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id: UPDATE_PLUGIN_ID,
          name: "Install Transaction Demo",
          version,
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(rootDir, "index.js"),
      `export default { id: ${JSON.stringify(UPDATE_PLUGIN_ID)}, register() {} };\n`,
      "utf8",
    ),
    fs.writeFile(path.join(rootDir, "payload.txt"), version, "utf8"),
  ]);
}

async function readInstallSnapshot(): Promise<ConfigSnapshotForInstallPersist> {
  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("expected valid fixture config");
  }
  return {
    config: snapshot.sourceConfig,
    baseHash: snapshot.hash,
    writeOptions: selectInstallMutationWriteOptions(writeOptions),
  };
}

describe("managed plugin install transaction", () => {
  it("restores the prior package when update persistence conflicts", async () => {
    await withOpenClawTestState(
      { label: "plugin-install-persistence-conflict", scenario: "minimal" },
      async (state) => {
        const v1Source = state.path("plugin-v1");
        const v2Source = state.path("plugin-v2");
        await Promise.all([
          writePluginFixture(v1Source, "1.0.0"),
          writePluginFixture(v2Source, "2.0.0"),
        ]);
        const [v1Archive, v2Archive] = await Promise.all([
          packToArchive({
            pkgDir: v1Source,
            outDir: state.root,
            outName: "plugin-v1.tgz",
            flatRoot: true,
          }),
          packToArchive({
            pkgDir: v2Source,
            outDir: state.root,
            outName: "plugin-v2.tgz",
            flatRoot: true,
          }),
        ]);

        const initial = await installManagedPluginSource({
          request: {
            source: "local",
            path: v1Archive,
            recordSource: "archive",
            mode: "install",
          },
          snapshot: await readInstallSnapshot(),
          env: state.env,
          invalidateRuntimeCache: false,
        });
        expect(initial.ok).toBe(true);
        if (!initial.ok || !initial.targetDir) {
          throw new Error("expected initial managed install target");
        }

        const installPath = initial.targetDir;
        const previousRecords = await readPersistedInstalledPluginIndexInstallRecords({
          env: state.env,
        });
        const staleSnapshot = await readInstallSnapshot();
        const concurrentConfigBytes = `${await fs.readFile(state.configPath, "utf8")}\n`;
        await fs.writeFile(state.configPath, concurrentConfigBytes, "utf8");

        await expect(
          installManagedPluginSource({
            request: {
              source: "local",
              path: v2Archive,
              recordSource: "archive",
              mode: "update",
            },
            snapshot: staleSnapshot,
            env: state.env,
            invalidateRuntimeCache: false,
          }),
        ).rejects.toThrow("config changed since last load");

        expect(await fs.readFile(path.join(installPath, "payload.txt"), "utf8")).toBe("1.0.0");
        expect(await fs.readFile(state.configPath, "utf8")).toBe(concurrentConfigBytes);
        expect(await readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          previousRecords,
        );

        const restarted = loadPluginMetadataSnapshot({
          config: (await readInstallSnapshot()).config,
          env: state.env,
          stateDir: state.stateDir,
          allowCurrent: false,
          preferPersisted: true,
        });
        expect(restarted.byPluginId.get(UPDATE_PLUGIN_ID)?.version).toBe("1.0.0");
      },
    );
  });
});
