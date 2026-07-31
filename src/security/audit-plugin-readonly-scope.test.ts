// Verifies plugin readonly-scope audit findings.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const resolveConfiguredChannelPluginIdsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (...args: unknown[]) =>
    resolveConfiguredChannelPluginIdsMock(...args),
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return {
    ...actual,
    getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
  };
});

vi.mock("../plugins/runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: (...args: unknown[]) =>
    loadPluginMetadataRegistrySnapshotMock(...args),
}));

const { runSecurityAudit } = await import("./audit.js");

function createAuditOptions(params: {
  sourceConfig: OpenClawConfig;
  plugins: Parameters<typeof runSecurityAudit>[0]["plugins"];
}): Parameters<typeof runSecurityAudit>[0] {
  return {
    config: params.sourceConfig,
    sourceConfig: params.sourceConfig,
    env: {},
    platform: process.platform,
    includeFilesystem: false,
    includeChannelSecurity: true,
    deep: false,
    deepTimeoutMs: 5000,
    stateDir: "/tmp/openclaw-test-state",
    configPath: "/tmp/openclaw-test-config.json",
    plugins: params.plugins,
    loadPluginSecurityCollectors: true,
    configSnapshot: null,
  };
}

function requireFirstMockArg<T>(mock: { mock: { calls: T[][] } }, label: string): T {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return expectDefined(arg, "arg test invariant");
}

describe("security audit read-only plugin scope", () => {
  beforeEach(() => {
    applyPluginAutoEnableMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    loadPluginMetadataRegistrySnapshotMock.mockReset();
    resolveConfiguredChannelPluginIdsMock.mockReset();
    getActivePluginRegistryMock.mockReturnValue(null);
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    loadPluginMetadataRegistrySnapshotMock.mockReturnValue({
      securityAuditCollectors: [],
    });
    resolveConfiguredChannelPluginIdsMock.mockReturnValue([]);
  });

  it("keeps configured channel owner collectors when the provided channel plugin list omits them", async () => {
    const sourceConfig = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        allow: ["external-channel-plugin", "audit-plugin"],
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({
      config: sourceConfig,
      changes: [],
      autoEnabledReasons: {
        "external-channel-plugin": ["channel:external"],
        "audit-plugin": ["explicit"],
      },
    });
    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["external-channel-plugin"]);

    await runSecurityAudit(
      createAuditOptions({
        sourceConfig,
        plugins: [],
      }),
    );

    const resolveConfiguredChannelPluginIdsParams = requireFirstMockArg(
      resolveConfiguredChannelPluginIdsMock,
      "configured channel plugin ids",
    ) as {
      config?: unknown;
      activationSourceConfig?: unknown;
      env?: unknown;
    };
    expect(resolveConfiguredChannelPluginIdsParams.config).toBe(sourceConfig);
    expect(resolveConfiguredChannelPluginIdsParams.activationSourceConfig).toBe(sourceConfig);
    expect(resolveConfiguredChannelPluginIdsParams.env).toStrictEqual({});

    const loadSnapshotParams = requireFirstMockArg(
      loadPluginMetadataRegistrySnapshotMock,
      "plugin metadata registry snapshot",
    ) as {
      onlyPluginIds?: string[];
    };
    expect(loadSnapshotParams.onlyPluginIds).toStrictEqual([
      "external-channel-plugin",
      "audit-plugin",
    ]);
  });

  it("removes configured channel owner collectors only when channel security will audit them", async () => {
    const sourceConfig = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        allow: ["external-channel-plugin", "audit-plugin"],
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({
      config: sourceConfig,
      changes: [],
      autoEnabledReasons: {
        "external-channel-plugin": ["channel:external"],
        "audit-plugin": ["explicit"],
      },
    });
    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["external-channel-plugin"]);

    await runSecurityAudit(
      createAuditOptions({
        sourceConfig,
        plugins: [{ id: "external-channel-plugin" }] as never,
      }),
    );

    const loadSnapshotParams = requireFirstMockArg(
      loadPluginMetadataRegistrySnapshotMock,
      "plugin metadata registry snapshot",
    ) as {
      onlyPluginIds?: string[];
    };
    expect(loadSnapshotParams.onlyPluginIds).toStrictEqual(["audit-plugin"]);
  });

  it("skips plugin runtime and collector discovery when collector loading is disabled", async () => {
    const sourceConfig = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        allow: ["audit-plugin"],
      },
    };

    const report = await runSecurityAudit({
      ...createAuditOptions({
        sourceConfig,
        plugins: [],
      }),
      loadPluginSecurityCollectors: false,
    });

    expect(report.findings.some((finding) => finding.checkId.startsWith("plugins."))).toBe(false);
    expect(getActivePluginRegistryMock).not.toHaveBeenCalled();
    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(loadPluginMetadataRegistrySnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps plain security audit off plugin collector runtime discovery by default", async () => {
    const sourceConfig = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        allow: ["audit-plugin"],
      },
    };

    await runSecurityAudit({
      config: sourceConfig,
      sourceConfig,
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
      stateDir: "/tmp/openclaw-test-state",
      configPath: "/tmp/openclaw-test-config.json",
    });

    expect(getActivePluginRegistryMock).not.toHaveBeenCalled();
    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(loadPluginMetadataRegistrySnapshotMock).not.toHaveBeenCalled();
  });
});
