import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.factory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { validatePluginSchemaValue } from "./schema-validator.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function registerCatalog(
  configExists: boolean | "dangling" | "fresh",
  initial?: boolean,
  options: { pluginId?: string; legacyDefaultEnabled?: boolean } = {},
) {
  const pluginId = options.pluginId ?? "fixture";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-catalog-"));
  roots.push(root);
  const configPath = path.join(root, "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  let source: OpenClawConfig =
    initial === undefined
      ? {}
      : {
          plugins: {
            entries: { [pluginId]: { config: { sessionCatalog: { enabled: initial } } } },
          },
        };
  if (configExists === "dangling") {
    await fs.symlink(path.join(root, "missing.json"), configPath);
  } else if (configExists === true) {
    await fs.writeFile(configPath, JSON.stringify(source));
  }
  const env = { HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
  const io = createConfigIO({
    env,
    homedir: () => root,
    observe: false,
    pluginValidation: "core-only",
  });
  if (configExists === "fresh") {
    await io.writeConfigFile(source);
  }
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot.exists).toBe(configExists === true || configExists === "fresh");
  const manifest: PluginManifestRecord = {
    id: pluginId,
    channels: [],
    providers: [],
    cliBackends: [],
    hooks: [],
    skills: [],
    origin: "bundled",
    enabledByDefault: true,
    rootDir: root,
    source: path.join(root, "index.js"),
    manifestPath: path.join(root, "openclaw.plugin.json"),
    setup: {
      nativeSessionCatalog: {
        label: "Fixture",
        nodeCommands: ["fixture.sessions.list", "fixture.sessions.static"],
        ...(options.legacyDefaultEnabled !== undefined
          ? { legacyDefaultEnabled: options.legacyDefaultEnabled }
          : {}),
      },
    },
    configSchema: {
      type: "object",
      properties: {
        sessionCatalog: {
          type: "object",
          default: {},
          properties: {
            enabled: { type: "boolean", default: true },
            pageSize: { type: "integer", default: 10 },
          },
        },
      },
    },
  };
  const pluginLocal = validatePluginSchemaValue({
    origin: "bundled",
    schema: manifest.configSchema!,
    cacheKey: manifest.manifestPath,
    value: {},
    applyDefaults: true,
  });
  expect(pluginLocal).toMatchObject({
    ok: true,
    value: { sessionCatalog: { enabled: true, pageSize: 10 } },
  });
  const validate = (input: OpenClawConfig) => {
    const validated = validateConfigObjectWithPlugins(
      {
        ...input,
        plugins: { ...input.plugins, slots: { memory: "none" } },
      },
      {
        env,
        homedir: () => root,
        pluginMetadataSnapshot: { manifestRegistry: { diagnostics: [], plugins: [manifest] } },
      },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      throw new Error("Fixture configuration is invalid");
    }
    return validated.config;
  };
  let config = validate(snapshot.sourceConfig ?? source);
  expect(config.plugins?.entries?.[pluginId]?.config).toEqual({
    sessionCatalog: {
      ...(initial !== undefined ? { enabled: initial } : {}),
      pageSize: 10,
    },
  });
  const registry = createPluginRegistry({
    runtime: { config: { current: () => config } } as PluginRuntime,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: pluginId,
    source: manifest.source,
    nativeSessionCatalog: manifest.setup?.nativeSessionCatalog,
  });
  registry.registry.plugins.push(record);
  const api = registry.createApi(record, { config });
  const list = vi.fn(async () => []);
  const read = vi.fn(async () => ({ hostId: "local", threadId: "thread", items: [] }));
  const available = vi.fn(() => true);
  const handle = vi.fn(async () => "[]");
  const staticHandle = vi.fn(async () => "[]");
  api.registerSessionCatalog({ id: "fixture", label: "Fixture", list, read });
  api.registerNodeHostCommand({ command: "fixture.sessions.list", isAvailable: available, handle });
  // Static definitions use the registrar directly even in setup-only modes.
  registry.registerNodeHostCommand(record, {
    command: "fixture.sessions.static",
    handle: staticHandle,
  });
  return {
    provider: registry.registry.sessionCatalogs[0]!.provider,
    node: registry.registry.nodeHostCommands[0]!.command,
    staticNode: registry.registry.nodeHostCommands[1]!.command,
    list,
    read,
    available,
    handle,
    staticHandle,
    async setPreference(enabled: boolean) {
      source = {
        plugins: { entries: { [pluginId]: { config: { sessionCatalog: { enabled } } } } },
      };
      await fs.writeFile(configPath, JSON.stringify(source));
      const updated = await io.readConfigFileSnapshot();
      config = validate(updated.sourceConfig);
    },
  };
}

describe("registered native catalog access", () => {
  it("requires opt-in for a new declared catalog after fresh configuration is written", async () => {
    const state = await registerCatalog("fresh", undefined, { legacyDefaultEnabled: true });
    await state.provider.list({});
    expect(state.list).not.toHaveBeenCalled();
    await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
    await expect(state.staticNode.handle()).rejects.toThrow("discovery is disabled");
    await state.setPreference(true);
    await state.provider.list({});
    expect(state.list).toHaveBeenCalledOnce();
  });
  it("does not inherit a legacy opt-in from a dangling config link", async () => {
    const state = await registerCatalog("dangling");
    expect(await state.provider.list({})).toEqual([]);
    await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
    await expect(state.staticNode.handle()).rejects.toThrow("discovery is disabled");
    expect(state.list).not.toHaveBeenCalled();
    expect(state.handle).not.toHaveBeenCalled();
    expect(state.staticHandle).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "blocks validated defaults from granting consent (file exists: %s)",
    async (exists) => {
      const state = await registerCatalog(exists, exists ? false : undefined);
      expect(await state.provider.list({ agentId: "research" })).toEqual([]);
      await expect(state.provider.read({ hostId: "local", threadId: "thread" })).rejects.toThrow(
        "discovery is disabled",
      );
      expect(state.node.isAvailable?.({ config: {}, env: {} })).toBe(false);
      await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
      await expect(state.staticNode.handle()).rejects.toThrow("discovery is disabled");
      expect(state.list).not.toHaveBeenCalled();
      expect(state.read).not.toHaveBeenCalled();
      expect(state.available).not.toHaveBeenCalled();
      expect(state.handle).not.toHaveBeenCalled();
      expect(state.staticHandle).not.toHaveBeenCalled();
      await state.setPreference(true);
      await state.provider.list({});
      await state.provider.read({ hostId: "local", threadId: "thread" });
      expect(state.node.isAvailable?.({ config: {}, env: {} })).toBe(true);
      await state.node.handle();
      await state.staticNode.handle();
      expect(state.list).toHaveBeenCalledOnce();
      expect(state.read).toHaveBeenCalledOnce();
      expect(state.handle).toHaveBeenCalledOnce();
      expect(state.staticHandle).toHaveBeenCalledOnce();
    },
  );

  it("preserves omitted legacy defaults and rechecks explicit disabling on retained handles", async () => {
    const state = await registerCatalog(true, undefined, { pluginId: "codex" });
    await state.provider.list({});
    await state.node.handle();
    await state.setPreference(false);
    expect(await state.provider.list({})).toEqual([]);
    await expect(state.node.handle()).rejects.toThrow("discovery is disabled");
    expect(state.list).toHaveBeenCalledOnce();
    expect(state.handle).toHaveBeenCalledOnce();
  });
});
