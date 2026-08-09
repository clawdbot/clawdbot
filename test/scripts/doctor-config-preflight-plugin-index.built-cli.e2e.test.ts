// Built-CLI proof for durable Doctor plugin-index refresh during gateway startup.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDefaultAgentDir } from "../../src/agents/agent-scope-config.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "../../src/agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { hasActiveStartupMigrationLease } from "../../src/infra/startup-migration-checkpoint.js";
import {
  readPersistedInstalledPluginIndexSync,
  writePersistedInstalledPluginIndexSync,
} from "../../src/plugins/installed-plugin-index-store.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { writeManagedNpmPlugin } from "../../src/plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawAgentDatabasesForTest } from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  clearPluginMetadataLifecycleCaches();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("Doctor plugin index persistence built CLI proof", () => {
  it("starts after replacing and verifying a stale persisted Doctor index", async () => {
    const instance = await createOpenClawTestInstance({
      name: "doctor-plugin-index-persistence",
      env: {
        OPENCLAW_TEST_FAST: "1",
      },
      startTimeoutMs: 90_000,
    });
    instances.push(instance);

    const config = JSON.parse(fs.readFileSync(instance.configPath, "utf8")) as OpenClawConfig;
    const pluginId = "legacy-doctor-index";
    const pluginDir = writeManagedNpmPlugin({
      stateDir: instance.stateDir,
      packageName: "@openclaw/legacy-doctor-index",
      pluginId,
      version: "1.0.0",
    });
    const packageJsonPath = path.join(pluginDir, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      openclaw: Record<string, unknown>;
    };
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({
        ...packageJson,
        openclaw: {
          ...packageJson.openclaw,
          build: {
            bundledDist: false,
            openclawVersion: "2026.7.2",
            pluginSdkVersion: "2026.7.2",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "doctor-contract-api.cjs"),
      "module.exports = { stateMigrations: [] };\n",
      "utf8",
    );

    const current = loadPluginMetadataSnapshot({
      config,
      env: instance.env,
      stateDir: instance.stateDir,
    });
    const legacyIndex = {
      ...current.index,
      plugins: current.index.plugins.map((plugin) => {
        const {
          doctorContractFile: _doctorContractFile,
          doctorContractHash: _doctorContractHash,
          ...legacyPlugin
        } = plugin;
        return legacyPlugin;
      }),
    };
    writePersistedInstalledPluginIndexSync(legacyIndex, { env: instance.env });
    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();

    expect(await instance.entrypoint()).toEqual([
      expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u),
    ]);
    await instance.startGateway();
    expect(hasActiveStartupMigrationLease({ env: instance.env }), instance.logs()).toBe(false);

    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();
    const reread = loadPluginMetadataSnapshot({
      config,
      env: instance.env,
      stateDir: instance.stateDir,
      allowCurrent: false,
    });
    expect(reread.registrySource, instance.logs()).toBe("persisted");
    expect(reread.registryDiagnostics, instance.logs()).toStrictEqual([]);

    const persisted = readPersistedInstalledPluginIndexSync({ env: instance.env });
    const persistedPlugin = persisted?.plugins.find((plugin) => plugin.pluginId === pluginId);
    expect(persistedPlugin, instance.logs()).toMatchObject({
      doctorContractFile: {
        ctimeMs: expect.any(Number),
        mtimeMs: expect.any(Number),
        size: expect.any(Number),
      },
      doctorContractHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      packageBuild: { bundledDist: false },
    });
  }, 120_000);

  it("refuses legacy roster and catalog state until Doctor repairs the full restart path", async () => {
    const instance = await createOpenClawTestInstance({
      name: "doctor-legacy-roster-model-catalog",
      env: {
        OPENCLAW_SKIP_PROVIDERS: "0",
        OPENCLAW_TEST_FAST: "1",
      },
      startTimeoutMs: 90_000,
    });
    instances.push(instance);

    const initialConfig = JSON.parse(
      fs.readFileSync(instance.configPath, "utf8"),
    ) as OpenClawConfig;
    const canonicalConfig = {
      ...initialConfig,
      agents: {
        entries: {
          main: {
            default: true,
            model: { primary: "zai/glm-5.2" },
          },
        },
      },
    } satisfies OpenClawConfig;
    fs.writeFileSync(instance.configPath, JSON.stringify(canonicalConfig), "utf8");
    const agentDir = resolveDefaultAgentDir(canonicalConfig, instance.env);
    const relativeCatalogPath = encodePluginModelCatalogRelativePath("zai");
    const sourcePath = path.join(agentDir, relativeCatalogPath);
    const contents = `${JSON.stringify(
      {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          zai: {
            api: "openai-completions",
            baseUrl: "https://api.z.ai/api/paas/v4",
            apiKey: "doctor-recovery-provider-test-key",
            models: [{ id: "glm-5.2", name: "GLM-5.2" }],
          },
        },
      },
      null,
      2,
    )}\n`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, contents, "utf8");

    await expect(instance.startGateway()).rejects.toThrow("openclaw doctor --fix");
    expect(instance.logs()).toContain("refusing to report the gateway ready");
    expect(instance.logs()).toContain("plugins/zai/catalog.json");
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(contents);
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);

    for (const command of [
      ["models", "list", "--provider", "zai", "--json"],
      ["models", "status", "--agent", "main", "--json"],
    ]) {
      const blocked = await instance.cli(command, { timeoutMs: 90_000 });
      const output = `${blocked.stderr}\n${blocked.stdout}`;
      expect(blocked.code, output).not.toBe(0);
      expect(output).toContain("openclaw doctor --fix");
      expect(output).toContain("plugins/zai/catalog.json");
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(contents);
      expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    }

    const legacyConfig = {
      ...canonicalConfig,
      agents: {
        list: [
          {
            id: "main",
            default: true,
            model: { primary: "zai/glm-5.2" },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    fs.writeFileSync(instance.configPath, JSON.stringify(legacyConfig), "utf8");

    const firstDoctor = await instance.cli(
      ["doctor", "--fix", "--yes", "--non-interactive", "--no-workspace-suggestions"],
      { timeoutMs: 90_000 },
    );
    expect(firstDoctor.code, `${firstDoctor.stderr}\n${firstDoctor.stdout}`).toBe(0);
    const repairedConfigContents = fs.readFileSync(instance.configPath, "utf8");
    const repairedConfig = JSON.parse(repairedConfigContents) as {
      agents?: { entries?: Record<string, { default?: boolean; model?: { primary?: string } }> };
    };
    expect(repairedConfig.agents?.entries).toEqual({
      main: {
        default: true,
        model: { primary: "zai/glm-5.2" },
      },
    });
    const repairedCatalogs = loadPersistedPluginModelCatalogs(agentDir);
    const zaiCatalog = repairedCatalogs.find((catalog) => catalog.pluginId === "zai");
    expect(zaiCatalog).toBeDefined();
    const parsedZaiCatalog = JSON.parse(zaiCatalog!.contents) as {
      providers?: { zai?: { apiKey?: string; models?: Array<{ id?: string }> } };
    };
    expect(parsedZaiCatalog.providers?.zai?.apiKey).toBe("doctor-recovery-provider-test-key");
    expect(parsedZaiCatalog.providers?.zai?.models).toContainEqual(
      expect.objectContaining({ id: "glm-5.2" }),
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    closeOpenClawAgentDatabasesForTest();

    const secondDoctor = await instance.cli(
      ["doctor", "--fix", "--yes", "--non-interactive", "--no-workspace-suggestions"],
      { timeoutMs: 90_000 },
    );
    expect(secondDoctor.code, `${secondDoctor.stderr}\n${secondDoctor.stdout}`).toBe(0);
    expect(fs.readFileSync(instance.configPath, "utf8")).toBe(repairedConfigContents);
    expect(loadPersistedPluginModelCatalogs(agentDir)).toEqual(repairedCatalogs);
    expect(fs.existsSync(sourcePath)).toBe(false);
    closeOpenClawAgentDatabasesForTest();

    await instance.startGateway();
    const models = await instance.cli(["models", "list", "--all", "--provider", "zai", "--json"], {
      timeoutMs: 90_000,
    });
    expect(models.code, `${models.stderr}\n${models.stdout}`).toBe(0);
    const payload = JSON.parse(models.stdout) as {
      models?: Array<{ key?: string; name?: string }>;
    };
    expect(payload.models).toContainEqual(
      expect.objectContaining({
        key: "zai/glm-5.2",
        name: "GLM-5.2",
      }),
    );

    const status = await instance.cli(["models", "status", "--agent", "main", "--json"], {
      timeoutMs: 90_000,
    });
    expect(status.code, `${status.stderr}\n${status.stdout}`).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ resolvedDefault: "zai/glm-5.2" });
  }, 180_000);
});
