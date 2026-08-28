import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginNpmProjectDir } from "../plugins/install-paths.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { maybeRepairStaleManagedNpmBundledPlugins } from "./doctor-plugin-registry.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("stale managed bundled plugin retirement", () => {
  it("preserves payload and record state for a non-bundled external plugin", async () => {
    const stateDir = makeTrackedTempDir("openclaw-doctor-plugin-retirement", tempDirs);
    const packageName = "@openclaw/external-demo";
    const version = "2026.5.2";
    const npmRoot = resolvePluginNpmProjectDir({
      npmDir: path.join(stateDir, "npm"),
      packageName,
    });
    const packageDir = path.join(npmRoot, "node_modules", "@openclaw", "external-demo");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(npmRoot, "package.json"),
      JSON.stringify({ dependencies: { [packageName]: version } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: packageName, version, openclaw: { extensions: ["."] } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "external-demo",
        name: "external-demo",
        configSchema: { type: "object" },
      }),
      "utf8",
    );
    const installRecords = {
      "external-demo": {
        source: "npm" as const,
        spec: `${packageName}@${version}`,
        installPath: packageDir,
        version,
        resolvedName: packageName,
        resolvedVersion: version,
        resolvedSpec: `${packageName}@${version}`,
      },
    };
    await writePersistedInstalledPluginIndex(
      {
        version: 1,
        hostContractVersion: "2026.4.25",
        compatRegistryVersion: "compat-v1",
        migrationVersion: 1,
        policyHash: "policy-v1",
        generatedAtMs: 1777118400000,
        installRecords,
        plugins: [],
        diagnostics: [],
      },
      { stateDir },
    );
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };

    const result = maybeRepairStaleManagedNpmBundledPlugins({
      stateDir,
      candidates: [],
      env,
      config: {
        plugins: {
          allow: ["external-demo"],
          entries: { "external-demo": { enabled: true } },
        },
      },
      prompter: { shouldRepair: true },
    });

    expect(result).toBeNull();
    expect(fs.existsSync(packageDir)).toBe(true);
    expect((await readPersistedInstalledPluginIndex({ stateDir }))?.installRecords).toEqual(
      installRecords,
    );
  });
});
