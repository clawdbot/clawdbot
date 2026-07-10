import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

type ConfigSnapshot = {
  exists: boolean;
  valid: boolean;
  path: string;
  hash: string | null;
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  issues: never[];
};

type CommitTransform = (
  currentConfig: OpenClawConfig,
  context: {
    previousHash: string | null;
    snapshot: ConfigSnapshot;
  },
) => { nextConfig: OpenClawConfig } | Promise<{ nextConfig: OpenClawConfig }>;

const mocks = vi.hoisted(() => ({
  state: {
    initialSnapshot: {} as ConfigSnapshot,
    commitConfig: {} as OpenClawConfig,
    commitSnapshot: {} as ConfigSnapshot,
    commitPreviousHash: "probe" as string | null,
    persistedConfig: undefined as OpenClawConfig | undefined,
  },
  events: [] as string[],
  readSnapshot: vi.fn<() => Promise<ConfigSnapshot>>(),
  commit: vi.fn(),
  ensureWorkspace: vi.fn(),
  ensureGatewayService: vi.fn(),
  refreshPluginRegistry: vi.fn(),
  updateExecApprovals: vi.fn(),
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: mocks.readSnapshot,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (config: OpenClawConfig) => ({
    ...config,
    wizard: {
      ...config.wizard,
      lastRunAt: "2026-07-10T00:00:00.000Z",
      lastRunVersion: "test",
      lastRunCommand: "onboard",
      lastRunMode: "local",
    },
  }),
  ensureWorkspaceAndSessions: mocks.ensureWorkspace,
  resolveLocalControlUiProbeLinks: () => ({ wsUrl: "ws://127.0.0.1:18789" }),
  waitForGatewayReachable: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  transformConfigWithPendingPluginInstalls: mocks.commit,
}));

vi.mock("../wizard/setup.gateway-config.js", () => ({
  configureGatewayForSetup: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
    nextConfig,
    settings: {
      authMode: "token",
      bind: "loopback",
      gatewayToken: "test-token",
      port: 18789,
    },
  })),
}));

vi.mock("../wizard/setup.finalize.js", () => ({
  ensureGatewayServiceForOnboarding: mocks.ensureGatewayService,
}));

vi.mock("../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistry,
}));

vi.mock("../infra/exec-approvals.js", () => ({
  updateExecApprovals: mocks.updateExecApprovals,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: (config: OpenClawConfig) =>
    config.agents?.list?.find((agent) => agent.default)?.id ?? "main",
  resolveAgentDir: (config: OpenClawConfig, agentId: string) =>
    config.agents?.list?.find((agent) => agent.id === agentId)?.agentDir ?? `/agents/${agentId}`,
}));

vi.mock("../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: ({ cfg }: { cfg: OpenClawConfig }) => {
    const configured = cfg.agents?.defaults?.model;
    const primary =
      (typeof configured === "string" ? configured : configured?.primary) ?? "openai/gpt-5.5";
    const [provider, ...modelParts] = primary.split("/");
    return { provider, model: modelParts.join("/") };
  },
}));

import { applyCrestodianSetup } from "./setup-apply.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function snapshot(hash: string | null, config: OpenClawConfig): ConfigSnapshot {
  return {
    exists: hash !== null,
    valid: true,
    path: "/tmp/openclaw.json",
    hash,
    config,
    sourceConfig: config,
    runtimeConfig: config,
    issues: [],
  };
}

function baseParams(overrides: Partial<Parameters<typeof applyCrestodianSetup>[0]> = {}) {
  return {
    workspace: "/tmp/openclaw-workspace",
    surface: "gateway" as const,
    runtime,
    ...overrides,
  };
}

describe("applyCrestodianSetup transaction boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    mocks.state.initialSnapshot = snapshot("probe", config);
    mocks.state.commitConfig = structuredClone(config);
    mocks.state.commitSnapshot = snapshot("probe", config);
    mocks.state.commitPreviousHash = "probe";
    mocks.state.persistedConfig = undefined;
    mocks.readSnapshot.mockImplementation(async () => mocks.state.initialSnapshot);
    mocks.commit.mockImplementation(async (params: { transform: CommitTransform }) => {
      const result = await params.transform(structuredClone(mocks.state.commitConfig), {
        previousHash: mocks.state.commitPreviousHash,
        snapshot: mocks.state.commitSnapshot,
      });
      mocks.events.push("commit");
      mocks.state.persistedConfig = result.nextConfig;
      return {
        nextConfig: result.nextConfig,
        path: "/tmp/openclaw.json",
        previousHash: mocks.state.commitPreviousHash,
        persistedHash: "persisted",
      };
    });
    mocks.ensureWorkspace.mockImplementation(async () => {
      mocks.events.push("workspace");
    });
    mocks.ensureGatewayService.mockResolvedValue({ installDaemon: false });
    mocks.refreshPluginRegistry.mockResolvedValue(undefined);
    mocks.updateExecApprovals.mockResolvedValue(undefined);
  });

  it.each([
    { expected: null, actual: "present" },
    { expected: "probe", actual: "different" },
  ])(
    "rejects initial $expected -> $actual revision drift before writing",
    async ({ expected, actual }) => {
      mocks.state.initialSnapshot = snapshot(actual, {});

      await expect(
        applyCrestodianSetup(baseParams({ expectedConfigHash: expected })),
      ).rejects.toThrow("config changed while AI access was being tested");

      expect(mocks.commit).not.toHaveBeenCalled();
      expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
    },
  );

  it("rechecks the probed revision inside the final transform", async () => {
    mocks.state.commitPreviousHash = "concurrent";

    await expect(applyCrestodianSetup(baseParams({ expectedConfigHash: "probe" }))).rejects.toThrow(
      "config changed while AI access was being tested",
    );

    expect(mocks.state.persistedConfig).toBeUndefined();
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "default agent",
      runtimeConfig: {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          list: [{ id: "other", default: true }],
        },
      },
      error: "default agent changed",
    },
    {
      name: "default model",
      runtimeConfig: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
      },
      error: "default model changed",
    },
  ])("rechecks the probed $name inside the final transform", async ({ runtimeConfig, error }) => {
    mocks.state.commitSnapshot = snapshot("probe", runtimeConfig);

    await expect(
      applyCrestodianSetup(
        baseParams({
          expectedConfigHash: "probe",
          expectedAgentId: "main",
          expectedModelRef: "openai/gpt-5.5",
        }),
      ),
    ).rejects.toThrow(error);

    expect(mocks.state.persistedConfig).toBeUndefined();
  });

  it("rejects same-revision agent credential directory drift in the final runtime snapshot", async () => {
    mocks.state.commitSnapshot = snapshot("probe", {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        list: [{ id: "main", default: true, agentDir: "/agents/moved" }],
      },
    });

    await expect(
      applyCrestodianSetup(
        baseParams({
          expectedConfigHash: "probe",
          expectedAgentId: "main",
          expectedAgentDir: "/agents/main",
        }),
      ),
    ).rejects.toThrow("agent credential location changed");

    expect(mocks.state.persistedConfig).toBeUndefined();
  });

  it("folds plugin and auth config into one commit while preserving concurrent edits", async () => {
    mocks.state.commitConfig = {
      ...mocks.state.commitConfig,
      logging: { level: "debug" },
    };
    mocks.state.commitSnapshot = snapshot("probe", mocks.state.commitConfig);

    const result = await applyCrestodianSetup(
      baseParams({
        expectedConfigHash: "probe",
        expectedAgentId: "main",
        expectedModelRef: "openai/gpt-5.5",
        enablePluginId: "codex",
        configPatch: { agents: { defaults: { maxConcurrent: 7 } } },
      }),
    );

    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.state.persistedConfig).toMatchObject({
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-workspace",
          maxConcurrent: 7,
          model: { primary: "openai/gpt-5.5" },
        },
      },
      logging: { level: "debug" },
      plugins: { entries: { codex: { enabled: true } } },
    });
    expect(result.configPath).toBe("/tmp/openclaw.json");
  });

  it("returns visible post-commit workspace, approval, registry, and service failures", async () => {
    mocks.ensureWorkspace.mockRejectedValueOnce(new Error("workspace exploded"));
    mocks.updateExecApprovals.mockRejectedValueOnce(new Error("approval exploded"));
    mocks.refreshPluginRegistry.mockRejectedValueOnce(new Error("registry exploded"));
    mocks.ensureGatewayService.mockRejectedValueOnce(new Error("service exploded"));

    const result = await applyCrestodianSetup(
      baseParams({
        expectedConfigHash: "probe",
        enablePluginId: "codex",
        refreshPluginRegistry: true,
        surface: "cli",
      }),
    );

    expect(mocks.events).toEqual(["commit"]);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        "Workspace files: workspace exploded",
        "Crestodian exec approval: approval exploded; local model harnesses may ask again.",
        "Plugin registry refresh failed: registry exploded",
        "Gateway service: service exploded",
      ]),
    );
  });
});
