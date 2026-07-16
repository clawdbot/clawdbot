// Plugins CLI update tests cover plugin update command behavior and output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { hashConfigIncludeRaw } from "../config/includes.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import {
  loadConfig,
  readConfigFileSnapshotForWrite,
  refreshPluginRegistry,
  registerPluginsCli,
  replaceConfigFile,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  runtimeLogs,
  setInstalledPluginIndexInstallRecords,
  updateNpmInstalledHookPacks,
  updateNpmInstalledPlugins,
  writeConfigFile,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./plugins-cli-test-helpers.js";

const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

function restoreTty(): void {
  if (ORIGINAL_STDIN_TTY) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_STDIN_TTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (ORIGINAL_STDOUT_TTY) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_STDOUT_TTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

function createTrackedPluginConfig(params: {
  pluginId: string;
  spec: string;
  resolvedName?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          source: "npm",
          spec: params.spec,
          installPath: `/tmp/${params.pluginId}`,
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
        },
      },
    },
  } as OpenClawConfig;
}

function expectRestartNoticeLogged() {
  expect(
    runtimeLogs.some((message) =>
      message.includes("Restart the gateway to load plugins and hooks."),
    ),
  ).toBe(true);
}

function expectSingleCallParams(mockFn: ReturnType<typeof vi.fn>) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  const params = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (params === undefined) {
    throw new Error("expected call params");
  }
  return params;
}

function primeUpdateConfigSnapshot(params: {
  config: OpenClawConfig;
  configPath?: string;
  loadedConfig?: OpenClawConfig;
  parsed?: Record<string, unknown>;
  runtimeConfig?: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  valid?: boolean;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
}): void {
  const configPath = params.configPath ?? path.join(process.cwd(), "openclaw.json5");
  const parsed = params.parsed ?? (params.config as Record<string, unknown>);
  const sourceConfig = params.sourceConfig ?? params.config;
  const runtimeConfig = params.runtimeConfig ?? params.config;
  loadConfig.mockReturnValue(params.loadedConfig ?? params.config);
  readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: {
      path: configPath,
      exists: true,
      raw: JSON.stringify(parsed),
      parsed,
      resolved: sourceConfig,
      sourceConfig,
      runtimeConfig,
      valid: params.valid ?? true,
      config: runtimeConfig,
      hash: "update-config",
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    writeOptions: {
      assertConfigPathForWrite: () => {},
      expectedConfigPath: configPath,
      ownedConfigPathForWrite: configPath,
      includeFileHashesForWrite: params.includeFileHashesForWrite,
      includeFileTargetsForWrite: params.includeFileTargetsForWrite,
    },
  });
}

function primeBlockedUpdateConfig(section: "hooks" | "plugins", config: OpenClawConfig): void {
  const externalPath = path.join(
    path.parse(process.cwd()).root,
    "external-openclaw",
    `${section}.json5`,
  );
  primeUpdateConfigSnapshot({
    config,
    parsed: { [section]: { $include: externalPath } },
    includeFileTargetsForWrite: {
      [externalPath]: externalPath,
    },
  });
}

describe("plugins cli update", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    restoreTty();
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
  });

  it("shows the deprecated unsafe install flag in update help", () => {
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const updateCommand = pluginsCommand?.commands.find((command) => command.name() === "update");
    const helpText = updateCommand?.helpInformation() ?? "";

    expect(helpText).toContain("--dangerously-force-unsafe-install");
    expect(helpText).toContain("Deprecated no-op");
    expect(helpText).toContain("security.installPolicy");
    expect(helpText).toContain("may still block");
  });

  it("refuses plugin updates in Nix mode before package-manager work", async () => {
    const previous = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow(
        "OPENCLAW_NIX_MODE=1",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previous;
      }
    }

    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("updates tracked hook packs through plugins update", async () => {
    const cfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.0.0",
              installPath: "/tmp/hooks/demo-hooks",
              resolvedName: "@acme/demo-hooks",
            },
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.1.0",
              installPath: "/tmp/hooks/demo-hooks",
            },
          },
        },
      },
    } as OpenClawConfig;

    primeUpdateConfigSnapshot({
      config: cfg,
      includeFileHashesForWrite: {
        "/tmp/hooks.json5": "hooks-start-hash",
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [],
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [
        {
          hookId: "demo-hooks",
          status: "updated",
          message: 'Updated hook pack "demo-hooks": 1.0.0 -> 1.1.0.',
        },
      ],
    });

    await runPluginsCommand(["plugins", "update", "demo-hooks"]);

    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacks);
    expect(hookUpdateParams.config).toBe(cfg);
    expect(hookUpdateParams.hookIds).toEqual(["demo-hooks"]);
    expect(writeConfigFile).toHaveBeenCalledWith(nextConfig);
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig,
      baseHash: "update-config",
      writeOptions: expect.objectContaining({
        includeFileHashesForWrite: {
          "/tmp/hooks.json5": "hooks-start-hash",
        },
      }),
    });
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expectRestartNoticeLogged();
  });

  it("uses the mutation-start snapshot for updater input and hook selection", async () => {
    const loadedConfig = {
      hooks: {
        internal: {
          installs: {
            "old-hooks": {
              source: "npm",
              spec: "@acme/old-hooks@1.0.0",
              installPath: "/tmp/hooks/old-hooks",
            },
          },
        },
      },
      plugins: {
        entries: {
          alpha: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const snapshotConfig = {
      hooks: {
        internal: {
          installs: {
            "new-hooks": {
              source: "npm",
              spec: "@acme/new-hooks@1.0.0",
              installPath: "~/.openclaw/hooks/new-hooks",
            },
          },
        },
      },
      plugins: {
        entries: {
          alpha: { enabled: false },
        },
      },
    } as OpenClawConfig;
    const installRecords = {
      alpha: {
        source: "npm",
        spec: "@openclaw/alpha@1.0.0",
        installPath: "/tmp/alpha",
      },
    } as const;
    primeUpdateConfigSnapshot({
      config: snapshotConfig,
      loadedConfig,
      runtimeConfig: {
        ...snapshotConfig,
        hooks: {
          internal: {
            installs: {
              "new-hooks": {
                source: "npm",
                spec: "@acme/new-hooks@1.0.0",
                installPath: "/home/test/.openclaw/hooks/new-hooks",
              },
            },
          },
        },
        messages: {
          ackReactionScope: "group-mentions",
        },
      },
    });
    setInstalledPluginIndexInstallRecords(installRecords);
    updateNpmInstalledPlugins.mockImplementation(async (params: { config: OpenClawConfig }) => ({
      config: params.config,
      changed: false,
      outcomes: [],
    }));
    updateNpmInstalledHookPacks.mockImplementation(async (params: { config: OpenClawConfig }) => ({
      config: params.config,
      changed: false,
      outcomes: [],
    }));

    await runPluginsCommand(["plugins", "update", "--all"]);

    const pluginUpdateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    const hookUpdateParams = expectSingleCallParams(updateNpmInstalledHookPacks);
    expect(pluginUpdateParams.config).toEqual({
      ...snapshotConfig,
      hooks: {
        internal: {
          installs: {
            "new-hooks": {
              source: "npm",
              spec: "@acme/new-hooks@1.0.0",
              installPath: "/home/test/.openclaw/hooks/new-hooks",
            },
          },
        },
      },
      messages: {
        ackReactionScope: "group-mentions",
      },
      plugins: {
        ...snapshotConfig.plugins,
        installs: installRecords,
      },
    });
    expect(hookUpdateParams.hookIds).toEqual(["new-hooks"]);
  });

  it("uses resolved shipped install records instead of raw env placeholders", async () => {
    const cfg = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@openclaw/alpha@1.0.0",
    });
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: {
        plugins: {
          installs: {
            alpha: {
              source: "npm",
              spec: "${PLUGIN_SPEC}",
              installPath: "${PLUGIN_PATH}",
            },
          },
        },
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.config).toEqual(cfg);
  });

  it("rejects invalid config snapshots before updater side effects", async () => {
    const cfg = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@openclaw/alpha@1.0.0",
    });
    primeUpdateConfigSnapshot({
      config: cfg,
      valid: false,
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});

    await expect(runPluginsCommand(["plugins", "update", "alpha"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toBe(
      "Cannot update plugins or hooks while the config is invalid.",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("blocks hook pack updates before updater side effects when hooks config is include-owned", async () => {
    const cfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.0.0",
              installPath: "/tmp/hooks/demo-hooks",
              resolvedName: "@acme/demo-hooks",
            },
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("hooks", cfg);

    await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config hooks are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("allows index-only legacy id migration when an included plugins section has no references", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    const pluginRecords = createTrackedPluginConfig({
      pluginId: "voice-call",
      spec: "@openclaw/voice-call@1.0.0",
    }).plugins?.installs;
    const nextConfig = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: {
          "@openclaw/voice-call": {
            source: "npm",
            spec: "@openclaw/voice-call@1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(pluginRecords ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [
        {
          pluginId: "@openclaw/voice-call",
          status: "updated",
          message: "Updated @openclaw/voice-call.",
        },
      ],
    });

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      nextConfig.plugins?.installs,
    );
    expect(writeConfigFile).toHaveBeenCalledWith(cfg);
  });

  it("allows scoped non-npm updates beside include-owned plugin config", async () => {
    const pluginId = "@acme/demo";
    const cfg = {
      plugins: {
        entries: {
          [pluginId]: { enabled: true },
        },
      },
    } as OpenClawConfig;
    const pluginRecords = {
      [pluginId]: {
        source: "git",
        spec: "https://github.com/acme/demo.git#v1.0.0",
        installPath: "/tmp/demo",
      },
    } as const;
    const nextConfig = {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        installs: pluginRecords,
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(pluginRecords);
    updateNpmInstalledPlugins.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [{ pluginId, status: "updated", message: `Updated ${pluginId}.` }],
    });

    await runPluginsCommand(["plugins", "update", pluginId]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(pluginRecords);
    expect(writeConfigFile).toHaveBeenCalledWith(cfg);
  });

  it("blocks legacy plugin id migration before updater side effects", async () => {
    const cfg = {
      plugins: {
        entries: {
          "voice-call": { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "ClawHub",
      record: {
        source: "clawhub",
        spec: "clawhub:@openclaw/voice-call",
        clawhubPackage: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    },
    {
      label: "git",
      record: {
        source: "git",
        spec: "https://github.com/openclaw/voice-call.git",
        installPath: "/tmp/voice-call",
      },
    },
    {
      label: "marketplace",
      record: {
        source: "marketplace",
        marketplaceSource: "acme",
        marketplacePlugin: "voice-call",
        installPath: "/tmp/voice-call",
      },
    },
  ] as const)(
    "blocks possible $label id migration before updater side effects",
    async ({ record }) => {
      const cfg = {
        plugins: {
          entries: {
            "voice-call": { enabled: true },
          },
        },
      } as OpenClawConfig;
      primeBlockedUpdateConfig("plugins", cfg);
      setInstalledPluginIndexInstallRecords({
        "voice-call": record,
      });

      await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
        "__exit__:1",
      );

      expect(runtimeErrors.at(-1)).toContain(
        "Config plugins are stored in an external or unresolved top-level $include",
      );
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it("blocks possible legacy id migration when an included plugins section is unresolved", async () => {
    const externalPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "plugins.json5",
    );
    const cfg = { plugins: {} } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      parsed: { plugins: { $include: externalPath } },
      sourceConfig: { plugins: { $include: externalPath } } as unknown as OpenClawConfig,
      includeFileTargetsForWrite: {
        [externalPath]: externalPath,
      },
    });
    setInstalledPluginIndexInstallRecords({
      "voice-call": {
        source: "npm",
        spec: "@openclaw/voice-call",
        installPath: "/tmp/voice-call",
      },
    });

    await expect(runPluginsCommand(["plugins", "update", "voice-call"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("preflights legacy plugin-record cleanup before hook-only updater side effects", async () => {
    const cfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.0.0",
              installPath: "/tmp/hooks/demo-hooks",
            },
          },
        },
      },
      plugins: {
        installs: {
          legacy: {
            source: "npm",
            spec: "@openclaw/legacy@1.0.0",
            installPath: "/tmp/legacy",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);

    await expect(runPluginsCommand(["plugins", "update", "demo-hooks"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("preserves skip behavior for plugin records whose source cannot be updated", async () => {
    const cfg = {
      plugins: {
        installs: {
          linked: {
            source: "path",
            sourcePath: "/tmp/linked",
            installPath: "/tmp/linked",
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [{ pluginId: "linked", status: "skipped", message: "Skipping linked." }],
    });

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("preserves skip behavior for ClawHub records missing package metadata", async () => {
    const cfg = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    primeBlockedUpdateConfig("plugins", cfg);
    setInstalledPluginIndexInstallRecords({
      demo: {
        source: "clawhub",
        spec: "clawhub:demo",
        installPath: "/tmp/demo",
      },
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [
        {
          pluginId: "demo",
          status: "skipped",
          message: 'Skipping "demo" (missing ClawHub package metadata).',
        },
      ],
    });

    await runPluginsCommand(["plugins", "update", "demo"]);

    expect(runtimeErrors).toEqual([]);
    expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("preserves an include-owned plugins section during legacy-record cleanup", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-update-"));
    const configPath = path.join(tempRoot, "openclaw.json5");
    const pluginsPath = path.join(tempRoot, "plugins.json5");
    const cfg = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@openclaw/alpha@1.0.0",
    });
    const pluginsRaw = `${JSON.stringify(cfg.plugins, null, 2)}\n`;
    const nextConfig = createTrackedPluginConfig({
      pluginId: "alpha",
      spec: "@openclaw/alpha@1.1.0",
    });
    fs.writeFileSync(pluginsPath, pluginsRaw);
    primeUpdateConfigSnapshot({
      config: cfg,
      configPath,
      parsed: { plugins: { $include: "./plugins.json5" } },
      includeFileHashesForWrite: {
        [pluginsPath]: hashConfigIncludeRaw(pluginsRaw),
      },
      includeFileTargetsForWrite: {
        [pluginsPath]: fs.realpathSync(pluginsPath),
      },
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config: nextConfig,
      changed: true,
      outcomes: [{ pluginId: "alpha", status: "updated", message: "Updated alpha." }],
    });

    try {
      await runPluginsCommand(["plugins", "update", "alpha"]);

      expect(runtimeErrors).toEqual([]);
      expect(updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
        nextConfig.plugins?.installs,
      );
      expect(writeConfigFile).toHaveBeenCalledWith({ plugins: {} });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("migrates included legacy install records while updating another indexed plugin", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-update-"));
    const configPath = path.join(tempRoot, "openclaw.json5");
    const pluginsPath = path.join(tempRoot, "plugins.json5");
    const legacyRecord = {
      source: "npm",
      spec: "@openclaw/legacy@1.0.0",
      installPath: "/tmp/legacy",
    } as const;
    const indexedRecord = {
      source: "npm",
      spec: "@openclaw/alpha@1.0.0",
      installPath: "/tmp/alpha",
    } as const;
    const updatedIndexedRecord = {
      ...indexedRecord,
      spec: "@openclaw/alpha@1.1.0",
    } as const;
    const cfg = {
      plugins: {
        installs: {
          legacy: legacyRecord,
        },
      },
    } as OpenClawConfig;
    const pluginsRaw = `${JSON.stringify(cfg.plugins, null, 2)}\n`;
    const nextInstallRecords = {
      alpha: updatedIndexedRecord,
      legacy: legacyRecord,
    };
    fs.writeFileSync(pluginsPath, pluginsRaw);
    primeUpdateConfigSnapshot({
      config: cfg,
      configPath,
      parsed: { plugins: { $include: "./plugins.json5" } },
      includeFileHashesForWrite: {
        [pluginsPath]: hashConfigIncludeRaw(pluginsRaw),
      },
      includeFileTargetsForWrite: {
        [pluginsPath]: fs.realpathSync(pluginsPath),
      },
    });
    setInstalledPluginIndexInstallRecords({
      alpha: indexedRecord,
    });
    updateNpmInstalledPlugins.mockResolvedValue({
      config: {
        plugins: {
          installs: nextInstallRecords,
        },
      } as OpenClawConfig,
      changed: true,
      outcomes: [{ pluginId: "alpha", status: "updated", message: "Updated alpha." }],
    });

    try {
      await runPluginsCommand(["plugins", "update", "alpha"]);

      expect(runtimeErrors).toEqual([]);
      const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
      expect(updateParams.config).toEqual({
        plugins: {
          installs: {
            alpha: indexedRecord,
            legacy: legacyRecord,
          },
        },
      });
      expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
        nextInstallRecords,
      );
      expect(writeConfigFile).toHaveBeenCalledWith({ plugins: {} });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks combined plugin and hook updates when either config section uses an include", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-update-"));
    const configPath = path.join(tempRoot, "openclaw.json5");
    const pluginsPath = path.join(tempRoot, "plugins.json5");
    const pluginsRaw = "{}\n";
    fs.writeFileSync(pluginsPath, pluginsRaw);
    const cfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.0.0",
              installPath: "/tmp/hooks/demo-hooks",
            },
          },
        },
      },
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.0.0",
            installPath: "/tmp/alpha",
          },
        },
      },
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      configPath,
      parsed: {
        hooks: {},
        plugins: { $include: "./plugins.json5" },
      },
      includeFileHashesForWrite: {
        [pluginsPath]: hashConfigIncludeRaw(pluginsRaw),
      },
      includeFileTargetsForWrite: {
        [pluginsPath]: fs.realpathSync(pluginsPath),
      },
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});

    try {
      await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow("__exit__:1");
      expect(runtimeErrors.at(-1)).toContain(
        "Config plugins and hooks cannot be updated together while either section uses a top-level $include",
      );
      expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
      expect(writeConfigFile).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("exits when update is called without id and without --all", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await expect(runPluginsCommand(["plugins", "update"])).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("Provide a plugin or hook-pack id, or use --all.");
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  it("reports no tracked plugins or hook packs when update --all has empty install records", async () => {
    loadConfig.mockReturnValue({
      plugins: {
        installs: {},
      },
    } as OpenClawConfig);

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toBe("No tracked plugins or hook packs to update.");
  });

  it("passes dangerous force unsafe install to plugin updates", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server@beta",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand([
      "plugins",
      "update",
      "openclaw-codex-app-server",
      "--dangerously-force-unsafe-install",
    ]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.config).toEqual(config);
    expect(updateParams.pluginIds).toEqual(["openclaw-codex-app-server"]);
    expect(updateParams.dangerouslyForceUnsafeInstall).toBe(true);
    expect(
      runtimeLogs.some((message) =>
        message.includes(
          "--dangerously-force-unsafe-install is deprecated and no longer affects plugin updates",
        ),
      ),
    ).toBe(true);
  });

  it("does not sync official catalog specs for manual plugin updates", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex@2026.5.28",
      resolvedName: "@openclaw/codex",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand(["plugins", "update", "codex"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.pluginIds).toEqual(["codex"]);
    expect(updateParams.syncOfficialPluginInstalls).toBeUndefined();
    expect(updateParams.updateChannel).toBeUndefined();
    expect(updateParams.officialPluginUpdateChannel).toBeUndefined();
  });

  it("syncs official catalog specs with beta channel context for update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex@2026.6.8-beta.1",
      resolvedName: "@openclaw/codex",
    });
    config.update = { channel: "beta" };
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand(["plugins", "update", "--all"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.pluginIds).toEqual(["codex"]);
    expect(updateParams.syncOfficialPluginInstalls).toBe(true);
    expect(updateParams.officialPluginUpdateChannel).toBe("beta");
    expect(updateParams.updateChannel).toBeUndefined();
  });

  it("passes extended-stable channel and installed core version to update --all", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "codex",
      spec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
    });
    config.update = { channel: "extended-stable" };
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand(["plugins", "update", "--all"]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        officialPluginUpdateChannel: "extended-stable",
        syncOfficialPluginInstalls: true,
        coreVersion: expect.any(String),
      }),
    );
  });

  it("passes ClawHub risk acknowledgement to plugin updates", async () => {
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "openclaw-codex-app-server@beta",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand([
      "plugins",
      "update",
      "openclaw-codex-app-server",
      "--acknowledge-clawhub-risk",
    ]);

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        pluginIds: ["openclaw-codex-app-server"],
        acknowledgeClawHubRisk: true,
      }),
    );
  });

  it("does not pass an interactive ClawHub risk prompt to dry-run plugin updates", async () => {
    setTty(true);
    const config = createTrackedPluginConfig({
      pluginId: "openclaw-codex-app-server",
      spec: "clawhub:openclaw-codex-app-server",
    });
    loadConfig.mockReturnValue(config);
    setInstalledPluginIndexInstallRecords(config.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      config,
      changed: false,
      outcomes: [],
    });

    await runPluginsCommand(["plugins", "update", "openclaw-codex-app-server", "--dry-run"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.dryRun).toBe(true);
    expect(updateParams.acknowledgeClawHubRisk).not.toBe(true);
    expect(updateParams.onClawHubRisk).toBeUndefined();
  });

  it("writes updated config when updater reports changes", async () => {
    const cfg = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.1.0",
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...cfg,
      messages: {
        ackReactionScope: "group-mentions",
      },
    } as OpenClawConfig;
    const nextRuntimeConfig = {
      ...nextConfig,
      messages: runtimeConfig.messages,
    } as OpenClawConfig;
    primeUpdateConfigSnapshot({
      config: cfg,
      runtimeConfig,
      includeFileHashesForWrite: {
        "/tmp/plugins.json5": "plugins-start-hash",
      },
    });
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      outcomes: [{ pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" }],
      changed: true,
      config: nextRuntimeConfig,
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextRuntimeConfig,
    });

    await runPluginsCommand(["plugins", "update", "alpha"]);

    const updateParams = expectSingleCallParams(updateNpmInstalledPlugins);
    expect(updateParams.config).toEqual(runtimeConfig);
    expect(updateParams.pluginIds).toEqual(["alpha"]);
    expect(updateParams.dryRun).toBe(false);
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      nextConfig.plugins?.installs,
    );
    expect(updateNpmInstalledHookPacks).not.toHaveBeenCalled();
    expect(writeConfigFile).toHaveBeenCalledWith({});
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: {},
      baseHash: "update-config",
      writeOptions: expect.objectContaining({
        includeFileHashesForWrite: {
          "/tmp/plugins.json5": "plugins-start-hash",
        },
      }),
    });
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {},
      installRecords: nextConfig.plugins?.installs,
      reason: "source-changed",
    });
    expectRestartNoticeLogged();
  });

  it("exits non-zero when a plugin update reports an error after persisting successes", async () => {
    const cfg = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.0.0",
          },
          beta: {
            source: "npm",
            spec: "@openclaw/beta@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    const nextConfig = {
      plugins: {
        installs: {
          alpha: {
            source: "npm",
            spec: "@openclaw/alpha@1.1.0",
          },
          beta: {
            source: "npm",
            spec: "@openclaw/beta@1.0.0",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      outcomes: [
        { pluginId: "alpha", status: "updated", message: "Updated alpha -> 1.1.0" },
        { pluginId: "beta", status: "error", message: "Failed to update beta: registry timeout" },
      ],
      changed: true,
      config: nextConfig,
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: nextConfig,
    });

    await expect(runPluginsCommand(["plugins", "update", "--all"])).rejects.toThrow("__exit__:1");

    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      nextConfig.plugins?.installs,
    );
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {},
      installRecords: nextConfig.plugins?.installs,
      reason: "source-changed",
    });
    expect(runtimeLogs).toContain("Failed to update beta: registry timeout");
  });

  it("exits non-zero when a ClawHub update is skipped for missing risk acknowledgement", async () => {
    const cfg = {
      plugins: {
        installs: {
          demo: {
            source: "clawhub",
            spec: "clawhub:@openclaw/plugin-demo@1.0.0",
            clawhubPackage: "@openclaw/plugin-demo",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      outcomes: [
        {
          pluginId: "demo",
          status: "skipped",
          code: CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED,
          message:
            "Skipped demo ClawHub update: Update cancelled; rerun with --acknowledge-clawhub-risk to continue after reviewing the warning. Existing installed plugin left unchanged.",
        },
      ],
      changed: false,
      config: cfg,
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: cfg,
    });

    await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");

    expect(writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toContain("--acknowledge-clawhub-risk");
  });

  it("exits non-zero when a ClawHub update is skipped because the target release is blocked", async () => {
    const cfg = {
      plugins: {
        installs: {
          demo: {
            source: "clawhub",
            spec: "clawhub:@openclaw/plugin-demo",
            clawhubPackage: "@openclaw/plugin-demo",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      outcomes: [
        {
          pluginId: "demo",
          status: "skipped",
          code: "clawhub_download_blocked",
          message:
            "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
        },
      ],
      changed: false,
      config: cfg,
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: cfg,
    });

    await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");

    expect(writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toContain("ClawHub blocked this release");
  });

  it("exits non-zero when a ClawHub update is skipped because security data is unavailable", async () => {
    const cfg = {
      plugins: {
        installs: {
          demo: {
            source: "clawhub",
            spec: "clawhub:@openclaw/plugin-demo",
            clawhubPackage: "@openclaw/plugin-demo",
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    setInstalledPluginIndexInstallRecords(cfg.plugins?.installs ?? {});
    updateNpmInstalledPlugins.mockResolvedValue({
      outcomes: [
        {
          pluginId: "demo",
          status: "skipped",
          code: "clawhub_security_unavailable",
          message:
            'Skipped demo ClawHub update: ClawHub security data for "@openclaw/plugin-demo@1.1.0" is unavailable, so OpenClaw left the existing installed plugin unchanged. Try again later or choose a different version.',
        },
      ],
      changed: false,
      config: cfg,
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      outcomes: [],
      changed: false,
      config: cfg,
    });

    await expect(runPluginsCommand(["plugins", "update", "demo"])).rejects.toThrow("__exit__:1");

    expect(writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(runtimeLogs.at(-1)).toContain("security data");
  });

  it("exits non-zero when a hook pack update reports an error", async () => {
    const cfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.0.0",
              installPath: "/tmp/hooks/demo-hooks",
              resolvedName: "@acme/demo-hooks",
            },
          },
        },
      },
    } as OpenClawConfig;
    loadConfig.mockReturnValue(cfg);
    updateNpmInstalledPlugins.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [],
    });
    updateNpmInstalledHookPacks.mockResolvedValue({
      config: cfg,
      changed: false,
      outcomes: [
        {
          hookId: "demo-hooks",
          status: "error",
          message: 'Failed to update hook pack "demo-hooks": registry timeout',
        },
      ],
    });

    await expect(runPluginsCommand(["plugins", "update", "demo-hooks"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(runtimeLogs).toContain('Failed to update hook pack "demo-hooks": registry timeout');
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
