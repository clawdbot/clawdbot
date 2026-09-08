import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { initializePublishedConfigRuntimeEnv } from "../config/config-env-vars.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import {
  refreshPluginRegistryAfterConfigMutation,
  refreshPluginRegistryForPreparedConfig,
} from "./registry-refresh.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

describe("plugin registry refresh config ownership", () => {
  it.each([
    { reason: "source-changed", envSource: "process" },
    { reason: "policy-changed", envSource: "process" },
    { reason: "source-changed", envSource: "caller" },
    { reason: "policy-changed", envSource: "caller" },
  ] as const)(
    "discovers an env-referenced plugin from $envSource env after $reason",
    async ({ reason, envSource }) => {
      await withOpenClawTestState(
        {
          label: "registry-refresh-env",
          layout: "split",
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", PLUGIN_DIR: undefined },
        },
        async (state) => {
          const pluginDir = state.path("plugin");
          await fs.mkdir(pluginDir);
          createColdPluginFixture({ rootDir: pluginDir, pluginId: "fixture-plugin" });
          const env =
            envSource === "caller" ? { ...process.env, PLUGIN_DIR: pluginDir } : undefined;
          if (envSource === "process") {
            process.env.PLUGIN_DIR = pluginDir;
          }
          const config = {
            plugins: {
              load: { paths: ["${PLUGIN_DIR}"] },
              entries: { "fixture-plugin": { enabled: true } },
            },
          };
          await state.writeConfig(config);
          const warn = vi.fn();
          await refreshPluginRegistryAfterConfigMutation({
            reason,
            env,
            invalidateRuntimeCache: false,
            logger: { warn },
          });
          expect(warn).not.toHaveBeenCalled();
          expect(readPersistedInstalledPluginIndexSync()?.plugins).toContainEqual(
            expect.objectContaining({
              pluginId: "fixture-plugin",
              rootDir: pluginDir,
              enabled: true,
            }),
          );
          expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
          expect(process.env.PLUGIN_DIR).toBe(envSource === "process" ? pluginDir : undefined);
          if (env) {
            expect(env.PLUGIN_DIR).toBe(pluginDir);
          }
        },
      );
    },
  );

  it.each(["copied-owned", "caller-override"] as const)(
    "reads the owned config without stale Gateway env (%s)",
    async (envSource) => {
      await withOpenClawTestState(
        {
          label: "registry-refresh-owned",
          layout: "split",
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", PLUGIN_DIR: undefined },
        },
        async (state) => {
          const pluginDir = state.path("plugin");
          await fs.mkdir(pluginDir);
          createColdPluginFixture({ rootDir: pluginDir, pluginId: "fixture-plugin" });
          const callerPluginDir = state.path("caller-plugin");
          await fs.mkdir(callerPluginDir);
          createColdPluginFixture({ rootDir: callerPluginDir, pluginId: "fixture-plugin" });
          const priorEnv = { PLUGIN_DIR: state.path("prior-plugin") };
          process.env.PLUGIN_DIR = priorEnv.PLUGIN_DIR;
          initializePublishedConfigRuntimeEnv({ env: { vars: priorEnv } }, { ownedEnv: priorEnv });
          await state.writeConfig({ plugins: { enabled: false } });
          const configPath = state.path("owned-config.json");
          await fs.writeFile(
            configPath,
            JSON.stringify({
              env: { vars: { PLUGIN_DIR: pluginDir } },
              plugins: {
                load: { paths: ["${PLUGIN_DIR}"] },
                entries: { "fixture-plugin": { enabled: true } },
              },
            }),
          );
          const env = {
            ...process.env,
            OPENCLAW_CONFIG_PATH: state.path("discovery-config.json"),
            ...(envSource === "caller-override" ? { PLUGIN_DIR: callerPluginDir } : {}),
          };
          const warn = vi.fn();
          await refreshPluginRegistryAfterConfigMutation({
            configPath,
            env,
            reason: "source-changed",
            invalidateRuntimeCache: false,
            logger: { warn },
          });
          expect(warn).not.toHaveBeenCalled();
          expect(readPersistedInstalledPluginIndexSync()?.plugins).toContainEqual(
            expect.objectContaining({
              pluginId: "fixture-plugin",
              rootDir: envSource === "caller-override" ? callerPluginDir : pluginDir,
              enabled: true,
            }),
          );
          expect(process.env.PLUGIN_DIR).toBe(priorEnv.PLUGIN_DIR);
          expect(process.env.OPENCLAW_CONFIG_PATH).toBe(state.configPath);
          expect(env.OPENCLAW_CONFIG_PATH).toBe(state.path("discovery-config.json"));
          expect(env.PLUGIN_DIR).toBe(
            envSource === "caller-override" ? callerPluginDir : priorEnv.PLUGIN_DIR,
          );
        },
      );
    },
  );

  it("resolves an external include using only the caller's allowed roots and path variables", async () => {
    await withOpenClawTestState(
      {
        label: "registry-refresh-caller-include",
        layout: "split",
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_INCLUDE_ROOTS: undefined,
          PLUGIN_DIR: undefined,
        },
      },
      async (state) => {
        const pluginDir = state.path("plugin");
        const includeRoot = state.path("shared");
        await fs.mkdir(pluginDir);
        await fs.mkdir(includeRoot);
        createColdPluginFixture({ rootDir: pluginDir, pluginId: "fixture-plugin" });
        const config = { plugins: { $include: "../shared/plugins.json" } };
        const plugins = {
          load: { paths: ["${PLUGIN_DIR}"] },
          entries: { "fixture-plugin": { enabled: true } },
        };
        await state.writeConfig(config);
        const includePath = state.path("shared", "plugins.json");
        await fs.writeFile(includePath, JSON.stringify(plugins));
        const env = { ...process.env, OPENCLAW_INCLUDE_ROOTS: includeRoot, PLUGIN_DIR: pluginDir };
        const warn = vi.fn();
        await refreshPluginRegistryAfterConfigMutation({
          configPath: state.configPath,
          env,
          reason: "source-changed",
          invalidateRuntimeCache: false,
          logger: { warn },
        });
        expect(warn).not.toHaveBeenCalled();
        expect(readPersistedInstalledPluginIndexSync({ env })?.plugins).toContainEqual(
          expect.objectContaining({
            pluginId: "fixture-plugin",
            rootDir: pluginDir,
            enabled: true,
          }),
        );
        expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(config);
        expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual(plugins);
        expect(process.env.OPENCLAW_INCLUDE_ROOTS).toBeUndefined();
        expect(process.env.PLUGIN_DIR).toBeUndefined();
        expect(env.OPENCLAW_INCLUDE_ROOTS).toBe(includeRoot);
        expect(env.PLUGIN_DIR).toBe(pluginDir);
      },
    );
  });

  it("keeps staged probe config and install receipts separate from the file, then restores disk policy", async () => {
    await withOpenClawTestState(
      { label: "registry-refresh-probe", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const pluginDir = state.path("staged-plugin");
        await fs.mkdir(pluginDir);
        createColdPluginFixture({ rootDir: pluginDir, pluginId: "fixture-plugin" });
        await state.writeConfig({ plugins: { enabled: false } });
        const config = {
          plugins: {
            load: { paths: [pluginDir] },
            entries: { "fixture-plugin": { enabled: true } },
          },
        };
        const installRecords = {
          "fixture-plugin": {
            source: "path" as const,
            sourcePath: pluginDir,
            installPath: pluginDir,
          },
        };
        await refreshPluginRegistryForPreparedConfig({
          config,
          installRecords,
          reason: "source-changed",
          invalidateRuntimeCache: false,
        });
        const stagedIndex = readPersistedInstalledPluginIndexSync();
        expect(stagedIndex?.plugins).toContainEqual(
          expect.objectContaining({ pluginId: "fixture-plugin", enabled: true }),
        );
        expect(stagedIndex?.installRecords).toEqual(installRecords);

        await fs.writeFile(state.configPath, "{ invalid config");
        const warn = vi.fn();
        await refreshPluginRegistryAfterConfigMutation({
          reason: "source-changed",
          invalidateRuntimeCache: false,
          logger: { warn },
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Plugin registry refresh failed: Config invalid:"),
        );
        expect(readPersistedInstalledPluginIndexSync()).toEqual(stagedIndex);

        await state.writeConfig({ plugins: { enabled: false } });
        await refreshPluginRegistryAfterConfigMutation({
          reason: "policy-changed",
          invalidateRuntimeCache: false,
        });
        expect(readPersistedInstalledPluginIndexSync()?.plugins).toContainEqual(
          expect.objectContaining({ pluginId: "fixture-plugin", enabled: false }),
        );
      },
    );
  });
});
