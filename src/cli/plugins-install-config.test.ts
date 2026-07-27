// Plugin install config tests cover install specs and generated plugin config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundledPluginRootAt, repoInstallSpec } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { hashConfigIncludeRaw } from "../config/includes.js";
import type { ConfigWriteOptions } from "../config/io.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import { loadConfigForInstall } from "./plugins-install-command.test-support.js";

const hoisted = vi.hoisted(() => ({
  assertConfigPathForWriteMock: vi.fn(),
  includeFileHashesForWriteMock: vi.fn<() => Record<string, string>>(),
  includeFileTargetsForWriteMock: vi.fn<() => Record<string, string>>(),
  readConfigFileSnapshotMock: vi.fn<() => Promise<ConfigFileSnapshot>>(),
  loadInstalledPluginIndexInstallRecordsMock: vi.fn(),
  listPersistedBundledPluginRecoveryLocationsMock: vi.fn(),
}));

const readConfigFileSnapshotMock = hoisted.readConfigFileSnapshotMock;
const assertConfigPathForWriteMock = hoisted.assertConfigPathForWriteMock;
const includeFileHashesForWriteMock = hoisted.includeFileHashesForWriteMock;
const includeFileTargetsForWriteMock = hoisted.includeFileTargetsForWriteMock;
const loadInstalledPluginIndexInstallRecordsMock =
  hoisted.loadInstalledPluginIndexInstallRecordsMock;
const listPersistedBundledPluginRecoveryLocationsMock =
  hoisted.listPersistedBundledPluginRecoveryLocationsMock;

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await readConfigFileSnapshotMock(),
    writeOptions: {
      assertConfigPathForWrite: assertConfigPathForWriteMock,
      basePluginMetadataSnapshot: {} as never,
      expectedConfigPath: "/tmp/config.json5",
      ownedConfigPathForWrite: "/tmp/config.json5",
      includeFileHashesForWrite: includeFileHashesForWriteMock(),
      includeFileTargetsForWrite: includeFileTargetsForWriteMock(),
    },
  }),
}));

vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexInstallRecords: () => loadInstalledPluginIndexInstallRecordsMock(),
  };
});

vi.mock("./plugins-location-bridges.js", () => ({
  listPersistedBundledPluginRecoveryLocations: () =>
    listPersistedBundledPluginRecoveryLocationsMock(),
}));

const DISCORD_REPO_INSTALL_SPEC = repoInstallSpec("discord");
const installWriteOptions = {
  assertConfigPathForWrite: assertConfigPathForWriteMock,
  // Central install persistence stamps the journal origin onto every write.
  auditOrigin: "plugin-install",
  expectedConfigPath: "/tmp/config.json5",
  ownedConfigPathForWrite: "/tmp/config.json5",
  includeFileHashesForWrite: { "/tmp/plugins.json5": "include-1" },
  includeFileTargetsForWrite: { "/tmp/plugins.json5": "/tmp/plugins.json5" },
} satisfies ConfigWriteOptions;

function makeSnapshot(overrides: Partial<ConfigFileSnapshot> = {}): ConfigFileSnapshot {
  return {
    path: "/tmp/config.json5",
    exists: true,
    raw: '{ "plugins": {} }',
    parsed: { plugins: {} },
    sourceConfig: { plugins: {} } as ConfigFileSnapshot["sourceConfig"],
    resolved: { plugins: {} } as OpenClawConfig,
    valid: false,
    runtimeConfig: { plugins: {} } as ConfigFileSnapshot["runtimeConfig"],
    config: { plugins: {} } as OpenClawConfig,
    hash: "abc",
    issues: [{ path: "plugins.installs.discord", message: "stale path" }],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

describe("loadConfigForInstall", () => {
  const discordNpmRequest = {
    rawSpec: "@openclaw/discord",
    normalizedSpec: "@openclaw/discord",
    installKind: "plugin",
    bundledPluginId: "discord",
    allowInvalidConfigRecovery: true,
  } satisfies PluginInstallRequestContext;

  beforeEach(() => {
    readConfigFileSnapshotMock.mockReset();
    includeFileHashesForWriteMock.mockReset();
    includeFileTargetsForWriteMock.mockReset();
    loadInstalledPluginIndexInstallRecordsMock.mockReset();
    listPersistedBundledPluginRecoveryLocationsMock.mockReset();

    loadInstalledPluginIndexInstallRecordsMock.mockResolvedValue({});
    includeFileHashesForWriteMock.mockReturnValue({
      "/tmp/plugins.json5": "include-1",
    });
    includeFileTargetsForWriteMock.mockReturnValue({
      "/tmp/plugins.json5": "/tmp/plugins.json5",
    });
    listPersistedBundledPluginRecoveryLocationsMock.mockResolvedValue([]);
  });

  it("returns the source config and base hash when the snapshot is valid", async () => {
    const cfg = { plugins: { entries: { discord: { enabled: true } } } } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        sourceConfig: cfg,
        config: { plugins: { entries: { discord: { enabled: true } }, enabled: true } },
        hash: "config-1",
        issues: [],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(result).toEqual({
      config: cfg,
      baseHash: "config-1",
      writeOptions: installWriteOptions,
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
  });

  it("returns valid source config unchanged", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        sourceConfig: cfg,
        config: cfg,
        issues: [],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(result.config).toBe(cfg);
  });

  it("falls back to snapshot config for explicit bundled-plugin reinstall when issues match the known upgrade failure", async () => {
    const snapshotCfg = {
      plugins: { installs: { discord: { source: "path", installPath: "/gone" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(readConfigFileSnapshotMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      config: snapshotCfg,
      baseHash: "abc",
      writeOptions: installWriteOptions,
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
  });

  it("allows versioned npm:-prefixed bundled-plugin reinstall recovery", async () => {
    const snapshotCfg = {
      plugins: { installs: { discord: { source: "path", installPath: "/gone" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "npm:@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.bundledPluginId).toBe("discord");
    expect(request.request.allowInvalidConfigRecovery).toBe(true);
    const result = await loadConfigForInstall(request.request);
    expect(result).toEqual({
      config: snapshotCfg,
      baseHash: "abc",
      writeOptions: installWriteOptions,
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
  });

  it.each(["file:@openclaw/discord", "FILE:@openclaw/discord"])(
    "does not treat %s as an official plugin recovery request",
    (rawSpec) => {
      const request = resolvePluginInstallRequestContext({ rawSpec });
      if (!request.ok) {
        throw new Error(request.error);
      }

      expect(request.request.bundledPluginId).toBeUndefined();
      expect(request.request.allowInvalidConfigRecovery).toBeUndefined();
    },
  );

  it("preserves a caller-proven plugin-only install kind", () => {
    const request = resolvePluginInstallRequestContext({
      rawSpec: "clawhub:demo",
      installKind: "plugin",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.installKind).toBe("plugin");
  });

  it("allows versioned official npm spec reinstall recovery", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        load: { paths: ["/gone", "/keep"] },
      },
      channels: { discord: { token: "preserve-me" } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} }, load: { paths: ["/gone", "/keep"] } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/discord@2026.5.22",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.bundledPluginId).toBe("discord");
    expect(request.request.allowInvalidConfigRecovery).toBe(true);
    const result = await loadConfigForInstall(request.request);
    expect(result).toEqual({
      config: {
        plugins: {
          installs: { discord: { source: "npm", installPath: "/gone" } },
          load: { paths: ["/keep"] },
        },
        channels: { discord: { token: "preserve-me" } },
      },
      baseHash: "abc",
      writeOptions: installWriteOptions,
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
  });

  it("uses the canonical plugin install record to own a stale recovery load path", async () => {
    const snapshotCfg = {
      plugins: { load: { paths: ["/gone", "/keep"] } },
    } as unknown as OpenClawConfig;
    loadInstalledPluginIndexInstallRecordsMock.mockResolvedValue({
      discord: { source: "npm", installPath: "/gone" },
    });
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { load: { paths: ["/gone", "/keep"] } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(result.config.plugins?.load?.paths).toEqual(["/keep"]);
  });

  it("does not let a stale legacy install record override the canonical record", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: "/gone" } },
        load: { paths: ["/gone"] },
      },
    } as unknown as OpenClawConfig;
    loadInstalledPluginIndexInstallRecordsMock.mockResolvedValue({
      discord: { source: "npm", installPath: "/canonical" },
    });
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {
          plugins: {
            installs: { discord: { source: "npm", installPath: "/gone" } },
            load: { paths: ["/gone"] },
          },
        },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
  });

  it("uses a persisted externalization bridge to own a stale bundled load path", async () => {
    const staleBundledPath = "/app/extensions/discord";
    const snapshotCfg = {
      plugins: { load: { paths: [staleBundledPath, "/keep"] } },
    } as unknown as OpenClawConfig;
    listPersistedBundledPluginRecoveryLocationsMock.mockResolvedValue([
      {
        pluginId: "discord",
        loadPaths: [staleBundledPath],
      },
    ]);
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { load: { paths: [staleBundledPath, "/keep"] } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          {
            path: "plugins.load.paths",
            message: `plugin: plugin path not found: ${staleBundledPath}`,
          },
        ],
      }),
    );

    const result = await loadConfigForInstall(discordNpmRequest);
    expect(result.config.plugins?.load?.paths).toEqual(["/keep"]);
  });

  it("rejects recovery rather than removing another plugin's missing load path", async () => {
    const operatorCheckoutPath = "/workspace/extensions/discord";
    const snapshotCfg = {
      plugins: {
        load: { paths: [operatorCheckoutPath] },
      },
    } as unknown as OpenClawConfig;
    listPersistedBundledPluginRecoveryLocationsMock.mockResolvedValue([
      {
        pluginId: "discord",
        loadPaths: ["/app/extensions/discord"],
      },
    ]);
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {
          plugins: {
            load: { paths: [operatorCheckoutPath] },
          },
        },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          {
            path: "plugins.load.paths",
            message: `plugin: plugin path not found: ${operatorCheckoutPath}`,
          },
        ],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
  });

  it("rejects malformed install record paths without crashing recovery", async () => {
    const snapshotCfg = {
      plugins: {
        installs: { discord: { source: "npm", installPath: 1 } },
        load: { paths: ["/gone"] },
      },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} }, load: { paths: ["/gone"] } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.discord", message: "unknown channel id: discord" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
  });

  it("rejects unattributed source-only runtime failures during official plugin recovery", async () => {
    const snapshotCfg = {
      plugins: { installs: { discord: { source: "npm", installPath: "/bad/discord" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { discord: {} } } },
        config: snapshotCfg,
        issues: [
          {
            path: "plugins",
            message:
              "plugin: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js, ./dist/index.mjs, ./dist/index.cjs, index.js, index.mjs, index.cjs. This is a plugin packaging issue, not a local config problem; update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then. TypeScript source fallback is only supported for source checkouts and local development paths.",
          },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "npm:@openclaw/discord",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    await expect(loadConfigForInstall(request.request)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
  });

  it("allows Brave official plugin reinstall recovery from source-only runtime shadows", async () => {
    const snapshotCfg = {
      plugins: { installs: { brave: { source: "clawhub", installPath: "/bad/brave" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { brave: {} } } },
        config: snapshotCfg,
        issues: [
          {
            path: "plugins.entries.brave",
            message:
              "plugin brave: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js.",
          },
          {
            path: "tools.web.search.provider",
            message:
              'web_search provider is not available: brave (install or enable plugin "brave", then run openclaw doctor --fix)',
          },
        ],
      }),
    );

    const request = resolvePluginInstallRequestContext({
      rawSpec: "@openclaw/brave-plugin",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request.allowInvalidConfigRecovery).toBe(true);
    const result = await loadConfigForInstall(request.request);
    expect(result).toEqual({
      config: snapshotCfg,
      baseHash: "abc",
      writeOptions: installWriteOptions,
      hookMutation: { mode: "allowed" },
      pluginMutation: { mode: "allowed" },
    });
  });

  it("allows explicit repo-checkout bundled-plugin reinstall recovery", async () => {
    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        config: snapshotCfg,
        issues: [{ path: "channels.discord", message: "unknown channel id: discord" }],
      }),
    );

    const repoRequest = resolvePluginInstallRequestContext({
      rawSpec: DISCORD_REPO_INSTALL_SPEC,
    });
    if (!repoRequest.ok) {
      throw new Error(repoRequest.error);
    }

    const result = await loadConfigForInstall({
      ...repoRequest.request,
      resolvedPath: bundledPluginRootAt("/tmp/repo", "discord"),
    });
    expect(result.config).toBe(snapshotCfg);
  });

  it("allows recovery through an exact single-file top-level plugins include", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-include-"));
    const configPath = path.join(tempRoot, "config.json5");
    const pluginsPath = path.join(tempRoot, "plugins.json5");
    const pluginsRaw = `${JSON.stringify({ entries: {} }, null, 2)}\n`;
    fs.writeFileSync(pluginsPath, pluginsRaw);
    includeFileHashesForWriteMock.mockReturnValue({
      [pluginsPath]: hashConfigIncludeRaw(pluginsRaw),
    });
    includeFileTargetsForWriteMock.mockReturnValue({
      [pluginsPath]: fs.realpathSync(pluginsPath),
    });
    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        path: configPath,
        parsed: { plugins: { $include: "./plugins.json5" } },
        config: snapshotCfg,
        issues: [{ path: "channels.discord", message: "unknown channel id: discord" }],
      }),
    );

    try {
      const result = await loadConfigForInstall(discordNpmRequest);
      expect(result.config).toBe(snapshotCfg);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects recovery installs through an external plugins include", async () => {
    const externalPluginsPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "plugins.json5",
    );
    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    includeFileTargetsForWriteMock.mockReturnValue({
      [externalPluginsPath]: externalPluginsPath,
    });
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { $include: externalPluginsPath } },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [{ path: "channels.discord", message: "unknown channel id: discord" }],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("rejects external include aliases even when their target is under the config directory", async () => {
    const configPath = path.join(process.cwd(), "config.json5");
    const externalPluginsPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "plugins.json5",
    );
    includeFileTargetsForWriteMock.mockReturnValue({
      [externalPluginsPath]: path.join(fs.realpathSync(process.cwd()), "plugins.json5"),
    });
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        path: configPath,
        parsed: { plugins: { $include: externalPluginsPath } },
        config: { plugins: {} } as OpenClawConfig,
        issues: [{ path: "channels.discord", message: "unknown channel id: discord" }],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("carries a plugin-mutation block for ambiguous installs through external plugin includes", async () => {
    const externalPluginsPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "plugins.json5",
    );
    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    includeFileTargetsForWriteMock.mockReturnValue({
      [externalPluginsPath]: externalPluginsPath,
    });
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        parsed: { plugins: { $include: externalPluginsPath } },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [],
      }),
    );

    const result = await loadConfigForInstall({
      rawSpec: "maybe-hook-pack",
      normalizedSpec: "maybe-hook-pack",
    });

    expect(result.config).toBe(snapshotCfg);
    expect(result.pluginMutation).toEqual({
      mode: "blocked",
      scope: "plugins",
      reason: expect.stringContaining("external or unresolved top-level $include"),
    });
  });

  it("blocks known plugins through external includes", async () => {
    const externalPluginsPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "plugins.json5",
    );
    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    includeFileTargetsForWriteMock.mockReturnValue({
      [externalPluginsPath]: externalPluginsPath,
    });
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        parsed: { plugins: { $include: externalPluginsPath } },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "external or unresolved top-level $include",
    );
  });

  it("carries a hook-mutation block through an external hooks include", async () => {
    const externalHooksPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "hooks.json5",
    );
    const snapshotCfg = { hooks: { internal: {} } } as OpenClawConfig;
    includeFileTargetsForWriteMock.mockReturnValue({
      [externalHooksPath]: externalHooksPath,
    });
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        parsed: { hooks: { $include: externalHooksPath } },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [],
      }),
    );

    const result = await loadConfigForInstall({
      rawSpec: "maybe-hook-pack",
      normalizedSpec: "maybe-hook-pack",
    });

    expect(result.hookMutation).toEqual({
      mode: "blocked",
      scope: "hooks",
      reason: expect.stringContaining("external or unresolved top-level $include"),
    });
    expect(result.pluginMutation).toEqual({ mode: "allowed" });
  });

  it("blocks config mutations when plugins and hooks share one canonical include target", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shared-include-"));
    const configPath = path.join(tempRoot, "config.json5");
    const sharedPath = path.join(tempRoot, "shared.json5");
    const sharedRaw = "{}\n";
    fs.writeFileSync(sharedPath, sharedRaw);
    includeFileHashesForWriteMock.mockReturnValue({
      [sharedPath]: hashConfigIncludeRaw(sharedRaw),
    });
    includeFileTargetsForWriteMock.mockReturnValue({
      [sharedPath]: fs.realpathSync(sharedPath),
    });
    const snapshotCfg = { hooks: {}, plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        path: configPath,
        valid: true,
        parsed: {
          hooks: { $include: "./shared.json5" },
          plugins: { $include: "./shared.json5" },
        },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [],
      }),
    );

    try {
      const result = await loadConfigForInstall({
        rawSpec: "maybe-hook-pack",
        normalizedSpec: "maybe-hook-pack",
      });
      expect(result.hookMutation).toEqual({
        mode: "blocked",
        scope: "config",
        reason: expect.stringContaining("share the same top-level $include target"),
      });
      expect(result.pluginMutation).toEqual(result.hookMutation);
      await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
        "share the same top-level $include target",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks both mutations when an external include aliases the other section target", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-aliased-include-"));
    const configPath = path.join(tempRoot, "config.json5");
    const sharedPath = path.join(tempRoot, "shared.json5");
    const externalHooksPath = path.join(
      path.parse(process.cwd()).root,
      "external-openclaw",
      "hooks.json5",
    );
    const sharedRaw = "{}\n";
    fs.writeFileSync(sharedPath, sharedRaw);
    includeFileHashesForWriteMock.mockReturnValue({
      [sharedPath]: hashConfigIncludeRaw(sharedRaw),
    });
    includeFileTargetsForWriteMock.mockReturnValue({
      [sharedPath]: fs.realpathSync(sharedPath),
      [externalHooksPath]: fs.realpathSync(sharedPath),
    });
    const snapshotCfg = { hooks: {}, plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        path: configPath,
        valid: true,
        parsed: {
          hooks: { $include: externalHooksPath },
          plugins: { $include: "./shared.json5" },
        },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [],
      }),
    );

    try {
      const result = await loadConfigForInstall({
        rawSpec: "maybe-hook-pack",
        normalizedSpec: "maybe-hook-pack",
      });
      expect(result.hookMutation).toEqual({
        mode: "blocked",
        scope: "config",
        reason: expect.stringContaining("share the same top-level $include target"),
      });
      expect(result.pluginMutation).toEqual(result.hookMutation);
      await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
        "share the same top-level $include target",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks nested plugins includes before plugin installation", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-nested-include-"));
    const configPath = path.join(tempRoot, "config.json5");
    const pluginsPath = path.join(tempRoot, "plugins.json5");
    const pluginsRaw = `${JSON.stringify({ entries: { $include: "./entries.json5" } }, null, 2)}\n`;
    fs.writeFileSync(pluginsPath, pluginsRaw);
    includeFileHashesForWriteMock.mockReturnValue({
      [pluginsPath]: hashConfigIncludeRaw(pluginsRaw),
    });
    includeFileTargetsForWriteMock.mockReturnValue({
      [pluginsPath]: fs.realpathSync(pluginsPath),
    });
    const snapshotCfg = { plugins: { entries: {} } } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        path: configPath,
        valid: true,
        parsed: { plugins: { $include: "./plugins.json5" } },
        sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
        config: snapshotCfg,
        issues: [],
      }),
    );

    try {
      const ambiguousResult = await loadConfigForInstall({
        rawSpec: "maybe-hook-pack",
        normalizedSpec: "maybe-hook-pack",
      });
      expect(ambiguousResult.pluginMutation).toEqual({
        mode: "blocked",
        scope: "plugins",
        reason: expect.stringContaining("nested $include"),
      });
      await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow("nested $include");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  const unsupportedPluginIncludeShapes = [
    {
      label: "plugins include array",
      parsed: { plugins: { $include: ["./plugins-a.json5", "./plugins-b.json5"] } },
      scope: "plugins",
    },
    {
      label: "plugins include with siblings",
      parsed: { plugins: { $include: "./plugins.json5", entries: {} } },
      scope: "plugins",
    },
    {
      label: "nested plugins include",
      parsed: { plugins: { entries: { $include: "./entries.json5" } } },
      scope: "plugins",
    },
    {
      label: "root include without authored plugins",
      parsed: { $include: "./root.json5" },
      scope: "config",
    },
    {
      label: "root include with authored plugins",
      parsed: { $include: "./root.json5", plugins: { entries: {} } },
      scope: "config",
    },
  ] as const;

  it.each(unsupportedPluginIncludeShapes)(
    "rejects recovery through an unsupported $label",
    async ({ parsed }) => {
      readConfigFileSnapshotMock.mockResolvedValue(
        makeSnapshot({
          parsed,
          config: { plugins: {} } as OpenClawConfig,
          issues: [{ path: "channels.discord", message: "unknown channel id: discord" }],
        }),
      );

      await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
        "Config plugin recovery uses an unsupported $include shape",
      );
    },
  );

  it.each(unsupportedPluginIncludeShapes)(
    "marks valid ambiguous installs through an unsupported $label as plugin-blocked",
    async ({ parsed, scope }) => {
      const snapshotCfg = { plugins: {} } as OpenClawConfig;
      readConfigFileSnapshotMock.mockResolvedValue(
        makeSnapshot({
          valid: true,
          parsed,
          sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
          config: snapshotCfg,
          issues: [],
        }),
      );

      const result = await loadConfigForInstall({
        rawSpec: "maybe-hook-pack",
        normalizedSpec: "maybe-hook-pack",
      });

      expect(result.pluginMutation).toEqual({
        mode: "blocked",
        scope,
        reason: expect.stringContaining("unsupported $include shape"),
      });
    },
  );

  it.each(unsupportedPluginIncludeShapes)(
    "blocks valid known plugins through an unsupported $label",
    async ({ parsed }) => {
      const snapshotCfg = { plugins: {} } as OpenClawConfig;
      readConfigFileSnapshotMock.mockResolvedValue(
        makeSnapshot({
          valid: true,
          parsed,
          sourceConfig: snapshotCfg as ConfigFileSnapshot["sourceConfig"],
          config: snapshotCfg,
          issues: [],
        }),
      );

      await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
        "unsupported $include shape",
      );
    },
  );

  it("rejects unrelated invalid config even during bundled-plugin reinstall recovery", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        issues: [{ path: "models.default", message: "invalid model ref" }],
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config invalid outside the plugin recovery path for discord",
    );
  });

  it("rejects non-Discord install requests when config is invalid", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());

    await expect(
      loadConfigForInstall({
        rawSpec: "alpha",
        normalizedSpec: "alpha",
      }),
    ).rejects.toThrow("Config invalid; run `openclaw doctor --fix` before installing plugins.");
  });

  it("throws when invalid snapshot parsed is empty", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: {},
        config: {} as OpenClawConfig,
      }),
    );

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });

  it("throws when invalid snapshot config file does not exist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot({ exists: false, parsed: {} }));

    await expect(loadConfigForInstall(discordNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });
});
