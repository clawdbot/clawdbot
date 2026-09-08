import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readBestEffortConfigSnapshot } from "../config/config.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import { registerPluginCliCommandsFromValidatedConfig } from "./cli.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import * as discovery from "./discovery.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("CLI config producer lifetime", () => {
  it.each(["empty", "missing", "missing-provider", "missing-direct-provider"] as const)(
    "owns discovery from the first %s config read through validated registration",
    async (kind) => {
      const root = fs.realpathSync(makePluginLoaderTempDir());
      const bundledDir = path.join(root, "bundled");
      const actionPath = path.join(root, "action.txt");
      const configPath = path.join(root, "openclaw.json");
      const descriptor =
        '{ name: "prepared", description: "Prepared command", hasSubcommands: false }';
      const plugin = writePlugin({
        id: "cold-cli",
        dir: path.join(bundledDir, "cold-cli"),
        filename: "index.cjs",
        body: `module.exports = { id: "cold-cli", register(api) {
          api.registerCli(({ program }) => program.command("prepared").action(() => require("node:fs").writeFileSync(${JSON.stringify(actionPath)}, api.registrationMode)), { descriptors: [${descriptor}] });
        } };`,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "cli-metadata.cjs"),
        `module.exports = { id: "cold-cli", register(api) {
        api.registerCli(() => {}, { descriptors: [{ ...${descriptor}, machineOutput: () => true }] });
      } };`,
      );
      const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          ...manifest,
          enabledByDefault: true,
          cliCommands: [
            { name: "prepared", description: "Prepared command", hasSubcommands: false },
          ],
        }),
      );
      if (kind.includes("provider")) {
        const owner = writePlugin({
          id: "defaults-owner",
          dir: path.join(
            bundledDir,
            kind === "missing-direct-provider" ? "anthropic" : "defaults-owner",
          ),
          filename: "index.cjs",
          body: 'throw new Error("provider runtime must not load for config defaults");',
        });
        fs.writeFileSync(
          path.join(owner.dir, "openclaw.plugin.json"),
          JSON.stringify({
            id: owner.id,
            providers: ["anthropic"],
            configSchema: { type: "object", properties: {} },
          }),
        );
        fs.writeFileSync(
          path.join(owner.dir, "provider-policy-api.js"),
          'exports.applyConfigDefaults = ({ config }) => ({ ...config, agents: { ...config.agents, defaults: { ...config.agents.defaults, contextPruning: { mode: "cache-ttl", ttl: "7m" } } } });',
        );
      }
      if (kind === "empty") {
        fs.writeFileSync(configPath, "{}");
      }
      await withEnvAsync(
        {
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          ANTHROPIC_API_KEY: kind.includes("provider") ? "synthetic-token" : undefined,
          ANTHROPIC_OAUTH_TOKEN: undefined,
        },
        async () => {
          const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
          const session = createPluginCliLoadSession();
          const read = await session.readConfig(() =>
            readBestEffortConfigSnapshot({
              observe: false,
              skipPluginValidation: true,
            }),
          );
          expect(read.configDiagnostics).toBeNull();
          expect(read.sourceConfig.agents?.defaults?.compaction).toBeUndefined();
          expect(read.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
          if (kind === "missing") {
            expect(discover).not.toHaveBeenCalled();
          }
          if (kind.includes("provider")) {
            expect(read.config.agents?.defaults?.contextPruning?.ttl).toBe("7m");
            if (kind === "missing-direct-provider") {
              expect(discover).not.toHaveBeenCalled();
            }
          }
          // The normal test harness disables unspecified plugins. Select this generated
          // plugin explicitly after proving missing/empty defaults, without changing the env.
          const enabledConfig = { ...read.config, plugins: { enabled: true, allow: [plugin.id] } };
          fs.writeFileSync(configPath, JSON.stringify({ plugins: enabledConfig.plugins }));
          const params = { cfg: enabledConfig, session, primaryCommand: "prepared" };
          const descriptors = await loadPluginCliDescriptors(params);
          expect(descriptors[0]?.machineOutput?.({ argv: [], stdoutIsTTY: true })).toBe(true);
          expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
          expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
          const program = new Command();
          expect(
            await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
              primary: "prepared",
              session,
            }),
          ).not.toBeNull();
          expect(program.commands.map((command) => command.name())).toEqual(["prepared"]);
          session.close();
          program.hook("preAction", () => clearPluginMetadataLifecycleCaches());
          await session.withCache(() => program.parseAsync(["prepared"], { from: "user" }));
          expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery");
          expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
          expect(() => session.resolve(params)).toThrow(/preparation is closed/);
          if (kind === "missing-provider") {
            const previousDiscoveries = discover.mock.calls.length;
            fs.unlinkSync(configPath);
            const core = await readConfigFileSnapshotFromContext(
              createConfigIoContext({
                env: process.env,
                observe: false,
                pluginValidation: "core-only",
              }),
            );
            expect(core.runtimeConfig.agents?.defaults?.contextPruning).toBeUndefined();
            expect(discover).toHaveBeenCalledTimes(previousDiscoveries);
          }
        },
      );
    },
  );
  it("retains skipped-validation metadata but rejects an invalid plugin at the fresh registration read", async () => {
    const root = fs.realpathSync(makePluginLoaderTempDir());
    const plugin = writePlugin({
      id: "invalid-cli",
      dir: path.join(root, "plugin"),
      filename: "index.cjs",
      configSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        additionalProperties: false,
      },
      body: 'throw new Error("invalid plugin must not execute");',
    });
    const rule = {
      path: ["plugins", "entries", plugin.id, "config", "label"],
      message: "Migrate the legacy numeric label to a string.",
    };
    fs.writeFileSync(
      path.join(plugin.dir, "doctor-contract-api.cjs"),
      `module.exports = { legacyConfigRules: [${JSON.stringify(rule)}] };`,
    );
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {
          load: { paths: [plugin.dir] },
          allow: [plugin.id],
          entries: { [plugin.id]: { config: { label: 17 } } },
        },
      }),
    );
    await withEnvAsync(
      {
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      async () => {
        const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
        const session = createPluginCliLoadSession();
        const read = await session.readConfig(() =>
          readBestEffortConfigSnapshot({ observe: false, skipPluginValidation: true }),
        );
        expect(read.configDiagnostics).toBeNull();
        const initialDiscoveries = discover.mock.calls.length;
        expect(initialDiscoveries).toBeGreaterThan(0);
        const invalid = await session.readConfig(() =>
          readConfigFileSnapshotFromContext(createConfigIoContext({ env: process.env })),
        );
        expect(invalid.valid).toBe(false);
        expect(invalid.legacyIssues).toEqual([
          { path: rule.path.join("."), message: rule.message },
        ]);
        expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
        const program = new Command();
        await expect(
          registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
            session,
            primary: "prepared",
          }),
        ).rejects.toMatchObject({
          code: "INVALID_CONFIG",
          details: expect.stringContaining("plugins.entries.invalid-cli.config.label"),
        });
        expect(program.commands).toEqual([]);
        session.close();
      },
    );
  });
});
