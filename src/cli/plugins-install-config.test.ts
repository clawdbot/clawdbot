import { bundledPluginRootAt, repoInstallSpec } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import {
  resolvePluginInstallRequestContext,
  type PluginInstallRequestContext,
} from "./plugin-install-config-policy.js";
import { loadConfigForInstall } from "./plugins-install-command.js";

const hoisted = vi.hoisted(() => ({
  readConfigFileSnapshotMock: vi.fn<() => Promise<ConfigFileSnapshot>>(),
  collectChannelDoctorStaleConfigMutationsMock: vi.fn(),
}));

const readConfigFileSnapshotMock = hoisted.readConfigFileSnapshotMock;
const collectChannelDoctorStaleConfigMutationsMock =
  hoisted.collectChannelDoctorStaleConfigMutationsMock;

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../commands/doctor/shared/channel-doctor.js", () => ({
  collectChannelDoctorStaleConfigMutations: (cfg: OpenClawConfig) =>
    collectChannelDoctorStaleConfigMutationsMock(cfg),
}));

const DISCORD_REPO_INSTALL_SPEC = repoInstallSpec("discord");

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
    bundledPluginId: "discord",
    allowInvalidConfigRecovery: true,
  } satisfies PluginInstallRequestContext;

  beforeEach(() => {
    readConfigFileSnapshotMock.mockReset();
    collectChannelDoctorStaleConfigMutationsMock.mockReset();

    collectChannelDoctorStaleConfigMutationsMock.mockImplementation(async (cfg: OpenClawConfig) => [
      {
        config: cfg,
        changes: [],
      },
    ]);
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
    expect(result).toEqual({ config: cfg, baseHash: "config-1" });
  });

  it("does not run stale Discord cleanup on the happy path", async () => {
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
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
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
    expect(readConfigFileSnapshotMock).toHaveBeenCalled();
    expect(collectChannelDoctorStaleConfigMutationsMock).toHaveBeenCalledWith(snapshotCfg);
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
  });

  it("allows npm:-prefixed bundled-plugin reinstall recovery", async () => {
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
      rawSpec: "npm:@openclaw/discord",
    });
    if (!request.ok) {
      throw new Error(request.error);
    }

    expect(request.request).toMatchObject({
      bundledPluginId: "discord",
      allowInvalidConfigRecovery: true,
    });
    const result = await loadConfigForInstall(request.request);
    expect(collectChannelDoctorStaleConfigMutationsMock).toHaveBeenCalledWith(snapshotCfg);
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
  });

  it("allows official plugin reinstall recovery from source-only runtime shadows", async () => {
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

    const result = await loadConfigForInstall(request.request);
    expect(collectChannelDoctorStaleConfigMutationsMock).toHaveBeenCalledWith(snapshotCfg);
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
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
