import { beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPluginRootAt, repoInstallSpec } from "../../test/helpers/bundled-plugin-paths.js";
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

const MATRIX_REPO_INSTALL_SPEC = repoInstallSpec("matrix");

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
    issues: [{ path: "plugins.installs.matrix", message: "stale path" }],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  };
}

describe("loadConfigForInstall", () => {
  const matrixNpmRequest = {
    rawSpec: "@openclaw/matrix",
    normalizedSpec: "@openclaw/matrix",
    bundledPluginId: "matrix",
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
    const cfg = { plugins: { entries: { matrix: { enabled: true } } } } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        sourceConfig: cfg,
        config: { plugins: { entries: { matrix: { enabled: true } }, enabled: true } },
        hash: "config-1",
        issues: [],
      }),
    );

    const result = await loadConfigForInstall(matrixNpmRequest);
    expect(result).toEqual({ config: cfg, baseHash: "config-1" });
  });

  it("does not run stale Matrix cleanup on the happy path", async () => {
    const cfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        valid: true,
        sourceConfig: cfg,
        config: cfg,
        issues: [],
      }),
    );

    const result = await loadConfigForInstall(matrixNpmRequest);
    expect(collectChannelDoctorStaleConfigMutationsMock).not.toHaveBeenCalled();
    expect(result.config).toBe(cfg);
  });

  it("falls back to snapshot config for explicit bundled-plugin reinstall when issues match the known upgrade failure", async () => {
    const snapshotCfg = {
      plugins: { installs: { matrix: { source: "path", installPath: "/gone" } } },
    } as unknown as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        parsed: { plugins: { installs: { matrix: {} } } },
        config: snapshotCfg,
        issues: [
          { path: "channels.matrix", message: "unknown channel id: matrix" },
          { path: "plugins.load.paths", message: "plugin: plugin path not found: /gone" },
        ],
      }),
    );

    const result = await loadConfigForInstall(matrixNpmRequest);
    expect(readConfigFileSnapshotMock).toHaveBeenCalled();
    expect(collectChannelDoctorStaleConfigMutationsMock).toHaveBeenCalledWith(snapshotCfg);
    expect(result).toEqual({ config: snapshotCfg, baseHash: "abc" });
  });

  it("allows explicit repo-checkout bundled-plugin reinstall recovery", async () => {
    const snapshotCfg = { plugins: {} } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        config: snapshotCfg,
        issues: [{ path: "channels.matrix", message: "unknown channel id: matrix" }],
      }),
    );

    const repoRequest = resolvePluginInstallRequestContext({
      rawSpec: MATRIX_REPO_INSTALL_SPEC,
    });
    if (!repoRequest.ok) {
      throw new Error(repoRequest.error);
    }

    const result = await loadConfigForInstall({
      ...repoRequest.request,
      resolvedPath: bundledPluginRootAt("/tmp/repo", "matrix"),
    });
    expect(result.config).toBe(snapshotCfg);
  });

  it("rejects unrelated invalid config even during bundled-plugin reinstall recovery", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(
      makeSnapshot({
        issues: [{ path: "models.default", message: "invalid model ref" }],
      }),
    );

    await expect(loadConfigForInstall(matrixNpmRequest)).rejects.toThrow(
      "Config invalid outside the bundled recovery path for matrix",
    );
  });

  it("rejects non-Matrix install requests when config is invalid", async () => {
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

    await expect(loadConfigForInstall(matrixNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });

  it("throws when invalid snapshot config file does not exist", async () => {
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot({ exists: false, parsed: {} }));

    await expect(loadConfigForInstall(matrixNpmRequest)).rejects.toThrow(
      "Config file could not be parsed; run `openclaw doctor` to repair it.",
    );
  });
});
