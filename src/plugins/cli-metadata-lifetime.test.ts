import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readBestEffortConfigSnapshot } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  loadPluginCliRegistrationEntriesWithDefaults,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import { registerPluginCliCommands, registerPluginCliCommandsFromValidatedConfig } from "./cli.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { loadOpenClawPluginCliRegistry } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("CLI prepared metadata lifetime", () => {
  it("invalidates prepared facts and captured registrars at the metadata lifecycle boundary", async () => {
    const root = fs.realpathSync(makePluginLoaderTempDir());
    const plugin = writePlugin({
      id: "lifetime-cli",
      dir: path.join(root, "plugin"),
      filename: "index.cjs",
      body: `module.exports = { id: "lifetime-cli", register(api) { api.registerCli(({program}) => program.command("prepared"), { descriptors: [{ name: "prepared", description: "Lifetime", hasSubcommands: false }] }); } };`,
    });
    const cfg = { plugins: { load: { paths: [plugin.dir] }, allow: [plugin.id] } };
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const session = createPluginCliLoadSession();
    const params = { cfg, env, session, primaryCommand: "prepared" };
    const entries = await loadPluginCliRegistrationEntriesWithDefaults(params);
    expect(entries).toHaveLength(1);
    fs.unlinkSync(path.join(plugin.dir, "openclaw.plugin.json"));
    clearPluginMetadataLifecycleCaches();
    const program = new Command();
    await expect(entries[0]!.register(program)).rejects.toThrow(/plugin CLI preparation/i);
    expect(program.commands).toEqual([]);
    // A revision fences authority without changing this independent operation's package facts.
    expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
    expect(
      await resolvePluginCliRootOwnerIds({ ...params, session: createPluginCliLoadSession() }),
    ).toEqual([]);
  });

  it("does not return registrars from preparation invalidated during an await", async () => {
    const root = fs.realpathSync(makePluginLoaderTempDir());
    const plugin = writePlugin({
      id: "pending-cli",
      dir: path.join(root, "plugin"),
      filename: "index.cjs",
      body: `module.exports = { id: "pending-cli", register(api) { api.registerCli(({program}) => program.command("prepared"), { commands: ["prepared"] }); } };`,
    });
    const pending = loadPluginCliRegistrationEntriesWithDefaults({
      cfg: { plugins: { load: { paths: [plugin.dir] }, allow: [plugin.id] } },
      env: {
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
      session: createPluginCliLoadSession(),
      primaryCommand: "prepared",
    });
    clearPluginMetadataLifecycleCaches();
    await expect(pending).rejects.toThrow(/plugin CLI preparation/i);
  });

  it.each([
    { first: "beta", owner: "alpha" },
    { first: "alpha", owner: "alpha" },
    { first: "beta", owner: undefined },
  ])(
    "validates all workspaces with $first first and execution owner $owner",
    async ({ first, owner }) => {
      const root = fs.realpathSync(makePluginLoaderTempDir());
      const configPath = path.join(root, "openclaw.json");
      for (const id of ["alpha", "beta"]) {
        writePlugin({
          id,
          dir: path.join(root, id, ".openclaw", "extensions", id),
          filename: "index.cjs",
          configSchema: {
            type: "object",
            properties: { label: { type: "string" } },
            additionalProperties: false,
          },
          body: `module.exports = { id: ${JSON.stringify(id)}, register(api) { require("node:fs").writeFileSync(${JSON.stringify(path.join(root, `${id}-registered`))}, api.registrationMode); api.registerCli(({program}) => program.command(${JSON.stringify(id)}), { descriptors: [{ name: ${JSON.stringify(id)}, description: "Workspace", hasSubcommands: false }] }); } };`,
        });
      }
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(
            [first, first === "alpha" ? "beta" : "alpha"].map((id) => [
              id,
              { workspace: path.join(root, id) },
            ]),
          ),
          ...(owner ? { defaults: { systemAgent: { agentId: owner } } } : {}),
        },
        plugins: { allow: ["alpha", "beta"], entries: { beta: { config: { label: "valid" } } } },
      };
      fs.writeFileSync(configPath, JSON.stringify(cfg));
      await withEnvAsync(
        {
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
        async () => {
          const session = createPluginCliLoadSession();
          const read = await session.readConfig(() =>
            readBestEffortConfigSnapshot({ observe: false }),
          );
          expect(read.configDiagnostics).toBeNull();
          const descriptors = await loadPluginCliDescriptors({ cfg: read.config, session });
          expect(descriptors.map((descriptor) => descriptor.name)).toEqual(owner ? ["alpha"] : []);
          const program = new Command();
          await registerPluginCliCommandsFromValidatedConfig(program, undefined, undefined, {
            session,
          });
          expect(program.commands.map((command) => command.name())).toEqual(owner ? ["alpha"] : []);
          expect(fs.existsSync(path.join(root, "beta-registered"))).toBe(false);
          expect(session.resolve({ cfg: read.config }).context.workspaceDir).toBe(
            owner ? path.join(root, owner) : undefined,
          );
          fs.writeFileSync(
            configPath,
            JSON.stringify({
              ...cfg,
              plugins: { ...cfg.plugins, entries: { beta: { config: { label: 17 } } } },
            }),
          );
          const rejected = new Command();
          await expect(
            registerPluginCliCommandsFromValidatedConfig(rejected, undefined, undefined, {
              session,
            }),
          ).rejects.toMatchObject({
            code: "INVALID_CONFIG",
            details: expect.stringContaining("plugins.entries.beta.config.label"),
          });
          expect(rejected.commands).toEqual([]);
          session.close();
        },
      );
    },
  );

  it.each(["process.env", "config", "source"] as const)(
    "refreshes eligible owners and executable callbacks after in-place %s input changes",
    async (input) => {
      const root = fs.realpathSync(makePluginLoaderTempDir());
      const bundledDir = path.join(root, "bundled");
      const actionPath = path.join(root, "action.txt");
      const plugin = writePlugin({
        id: "cli-inputs",
        dir: path.join(bundledDir, "cli-inputs"),
        filename: "index.cjs",
        body: `module.exports = { id: "cli-inputs", register(api) {
  api.registerCli(({ program }) => program.command("prepared").action(() => require("node:fs").writeFileSync(${JSON.stringify(actionPath)}, api.registrationMode)), {
    descriptors: [{ name: "prepared", description: "Prepared command", hasSubcommands: false }],
  });
} };`,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "cli-metadata.cjs"),
        'module.exports = require("./index.cjs");',
      );
      const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(manifestPath, "utf8")),
          channels: [plugin.id],
          autoEnableWhenConfiguredProviders: [plugin.id],
        }),
      );
      fs.writeFileSync(
        path.join(plugin.dir, "package.json"),
        JSON.stringify({
          name: "@openclaw/cli-inputs",
          openclaw: {
            extensions: ["./index.cjs"],
            channel: { id: plugin.id, configuredState: { env: { allOf: ["CLI_INPUTS_TOKEN"] } } },
          },
        }),
      );
      await withEnvAsync(
        {
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          CLI_INPUTS_TOKEN: undefined,
        },
        async () => {
          const cfg: OpenClawConfig = {
            agents: { defaults: { workspace: path.join(root, "workspace") } },
            plugins: { enabled: true },
            auth: { profiles: {} },
          };
          if (input === "source") {
            setRuntimeConfigSnapshot(cfg, { ...cfg });
          }
          const gateway = resolvePluginRuntimeLoadContext({ config: cfg });
          setCurrentPluginMetadataSnapshot(gateway.metadataSnapshot, {
            config: cfg,
            env: process.env,
            workspaceDir: gateway.workspaceDir,
          });
          const session = createPluginCliLoadSession();
          const params = { cfg, session, primaryCommand: "prepared" };
          for (const enabled of [false, true, false]) {
            if (input === "process.env") {
              setTestEnvValue("CLI_INPUTS_TOKEN", enabled ? "synthetic-token" : "");
            } else if (input === "config") {
              cfg.auth!.profiles = enabled
                ? { fixture: { provider: plugin.id, mode: "api_key" } }
                : {};
            } else {
              expect(
                setRuntimeConfigSourceSnapshotIfCurrent({
                  expectedRevision: getRuntimeConfigSnapshotMetadata()!.revision,
                  sourceConfig: {
                    ...cfg,
                    plugins: { enabled: true, entries: { [plugin.id]: { enabled } } },
                  },
                }),
              ).toBe(true);
            }
            expect((await loadPluginCliDescriptors(params)).map((entry) => entry.name)).toEqual(
              enabled ? ["prepared"] : [],
            );
            expect(await resolvePluginCliRootOwnerIds(params)).toEqual(enabled ? [plugin.id] : []);
            const program = new Command();
            await registerPluginCliCommands(program, cfg, undefined, undefined, {
              primary: "prepared",
              session,
            });
            expect(program.commands.map((command) => command.name())).toEqual(
              enabled ? ["prepared"] : [],
            );
            if (enabled) {
              await program.parseAsync(["prepared"], { from: "user" });
              expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery");
            }
            expect(
              getCurrentPluginMetadataSnapshot({
                config: cfg,
                env: process.env,
                workspaceDir: gateway.workspaceDir,
              }),
            ).toBe(gateway.metadataSnapshot);
          }
        },
      );
    },
  );

  it("does not borrow another environment's Gateway graph through config identity", async () => {
    const root = fs.realpathSync(makePluginLoaderTempDir());
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: path.join(root, "workspace") } },
      plugins: { allow: ["environment-cli"], entries: { "environment-cli": { enabled: true } } },
    };
    const environments = ["gateway", "cli"].map((label) => {
      const stateDir = path.join(root, label);
      writePlugin({
        id: "environment-cli",
        dir: path.join(stateDir, "extensions", "environment-cli"),
        filename: "index.cjs",
        body: `module.exports = { id: "environment-cli", register(api) { api.registerCli(() => {}, { descriptors: [{ name: "prepared", description: ${JSON.stringify(label)}, hasSubcommands: false }] }); } };`,
      });
      return { HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    });
    const gateway = resolvePluginRuntimeLoadContext({ config: cfg, env: environments[0] });
    expect(gateway.metadataSnapshot).toBeDefined();
    setCurrentPluginMetadataSnapshot(gateway.metadataSnapshot, {
      config: cfg,
      env: environments[0],
      workspaceDir: gateway.workspaceDir,
    });
    expect(
      await loadPluginCliDescriptors({
        cfg,
        env: environments[1],
        session: createPluginCliLoadSession(),
        primaryCommand: "prepared",
      }),
    ).toMatchObject([{ description: "cli" }]);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: cfg,
        env: environments[0],
        workspaceDir: gateway.workspaceDir,
      }),
    ).toBe(gateway.metadataSnapshot);
  });

  it.each([false, true])(
    "carries discovery through output, ownership, and registration (legacy=%s)",
    async (legacy) => {
      const root = fs.realpathSync(makePluginLoaderTempDir());
      const actionPath = path.join(root, "action.txt");
      const plugin = writePlugin({
        id: "invocation-cli",
        dir: path.join(root, "plugin"),
        filename: "index.cjs",
        configSchema: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        },
        body: `module.exports = {
  id: "invocation-cli",
  register(api) {
    api.registerCli(({ program }) => program.command("prepared").action(() => require("node:fs").writeFileSync(${JSON.stringify(actionPath)}, api.registrationMode + ":" + api.pluginConfig.label)), {
      descriptors: [{ name: "prepared", description: "Prepared command", hasSubcommands: false, machineOutput: () => true }],
    });
  },
};`,
      });
      const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
      if (!legacy) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        manifest.cliCommands = [
          { name: "prepared", description: "Prepared command", hasSubcommands: false },
        ];
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      const env = {
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const cfg: OpenClawConfig = {
        plugins: {
          load: { paths: [plugin.dir] },
          allow: [plugin.id],
          entries: { [plugin.id]: { enabled: true, config: { label: "first" } } },
        },
      };
      const session = createPluginCliLoadSession();
      const params = { cfg, env, primaryCommand: "prepared", session };
      const descriptors = await loadPluginCliDescriptors(params);
      expect(descriptors[0]?.machineOutput?.({ argv: [], stdoutIsTTY: true })).toBe(true);
      fs.unlinkSync(manifestPath);
      expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
      const program = new Command();
      await registerPluginCliCommands(program, cfg, env, undefined, {
        primary: "prepared",
        session,
      });
      expect(program.commands.map((command) => command.name())).toEqual(["prepared"]);
      await program.parseAsync(["prepared"], { from: "user" });
      expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery:first");
      const changedConfig = {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: { [plugin.id]: { enabled: true, config: { label: "second" } } },
        },
      };
      const changedProgram = new Command();
      await registerPluginCliCommands(changedProgram, changedConfig, env, undefined, {
        primary: "prepared",
        session,
      });
      await changedProgram.parseAsync(["prepared"], { from: "user" });
      expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery:second");
      expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
      expect(
        await resolvePluginCliRootOwnerIds({ ...params, session: createPluginCliLoadSession() }),
      ).toEqual([]);
    },
  );

  it.each([false, true])(
    "isolates changed workspace and policy (new invocation=%s)",
    async (independent) => {
      const root = fs.realpathSync(makePluginLoaderTempDir());
      const env = {
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const createWorkspace = (label: string) => {
        const workspace = path.join(root, label);
        writePlugin({
          id: "workspace-cli",
          dir: path.join(workspace, ".openclaw", "extensions", "workspace-cli"),
          filename: "index.cjs",
          body: `module.exports = { id: "workspace-cli", register(api) {
          api.registerCli(({ program }) => program.command("prepared").description(${JSON.stringify(label)}), {
            descriptors: [{ name: "prepared", description: ${JSON.stringify(label)}, hasSubcommands: false }],
          });
        } };`,
        });
        return workspace;
      };
      const firstWorkspace = createWorkspace("first");
      const secondWorkspace = createWorkspace("second");
      const config = (workspace: string, enabled = true): OpenClawConfig => ({
        agents: { defaults: { workspace } },
        plugins: { allow: ["workspace-cli"], entries: { "workspace-cli": { enabled } } },
      });
      const firstSession = createPluginCliLoadSession();
      expect(
        await loadPluginCliDescriptors({
          cfg: config(firstWorkspace),
          env,
          session: firstSession,
          primaryCommand: "prepared",
        }),
      ).toMatchObject([{ description: "first" }]);
      const session = independent ? createPluginCliLoadSession() : firstSession;
      const cfg = config(secondWorkspace);
      const params = { cfg, env, session, primaryCommand: "prepared" };
      expect(await loadPluginCliDescriptors(params)).toMatchObject([{ description: "second" }]);
      expect(await resolvePluginCliRootOwnerIds(params)).toEqual(["workspace-cli"]);
      const program = new Command();
      await registerPluginCliCommands(program, cfg, env, undefined, {
        primary: "prepared",
        session,
      });
      expect(program.commands.map((command) => command.description())).toEqual(["second"]);
      const disabled = config(secondWorkspace, false);
      expect(await loadPluginCliDescriptors({ ...params, cfg: disabled })).toEqual([]);
      expect(await resolvePluginCliRootOwnerIds({ ...params, cfg: disabled })).toEqual([]);
      const disabledProgram = new Command();
      await registerPluginCliCommands(disabledProgram, disabled, env, undefined, {
        primary: "prepared",
        session,
      });
      expect(disabledProgram.commands).toEqual([]);
      expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
    },
  );

  it.each(["enabled", "disabled", "invalid"] as const)(
    "uses supplied manifests without rediscovery and retains %s policy",
    async (policy) => {
      const root = fs.realpathSync(makePluginLoaderTempDir());
      const plugin = writePlugin({
        id: "prepared-cli",
        dir: path.join(root, "plugin"),
        filename: "index.cjs",
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: { label: { type: "string" } },
          required: ["label"],
        },
        body: `module.exports = {
  id: "prepared-cli",
  register(api) {
    api.registerCli(({ program }) => program.command("prepared").description(api.pluginConfig.label), {
      descriptors: [{ name: "prepared", description: api.pluginConfig.label, hasSubcommands: false }],
    });
  },
};`,
      });
      const env = {
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      const config: OpenClawConfig = {
        plugins: {
          load: { paths: [plugin.dir] },
          allow: [plugin.id],
          entries: {
            [plugin.id]: {
              enabled: policy !== "disabled",
              config: { label: policy === "invalid" ? 42 : "Prepared command" },
            },
          },
        },
      };
      const manifestRegistry = loadPluginManifestRegistryCore({ config, env });
      expect(manifestRegistry.plugins.map((entry) => entry.id)).toEqual([plugin.id]);
      // The caller owns this graph; subsequent discovery cannot recover the removed manifest.
      fs.unlinkSync(path.join(plugin.dir, "openclaw.plugin.json"));
      const registry = await loadOpenClawPluginCliRegistry({
        config,
        env,
        manifestRegistry,
        installRecords: {},
      });
      expect(registry.plugins.map((entry) => [entry.id, entry.status])).toEqual([
        [plugin.id, policy === "enabled" ? "loaded" : policy === "disabled" ? "disabled" : "error"],
      ]);
      expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toEqual(
        policy === "enabled" ? ["prepared"] : [],
      );
    },
  );
});
