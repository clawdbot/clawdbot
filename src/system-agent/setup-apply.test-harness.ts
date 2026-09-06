import { vi } from "vitest";
import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

type ConfigSnapshot = {
  exists: boolean;
  valid: boolean;
  path: string;
  hash: string | null;
  parsed: unknown;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  issues: Array<{ path?: string; message: string }>;
};

export type CommitTransform = (
  currentConfig: OpenClawConfig,
  context: {
    previousHash: string | null;
    snapshot: ConfigSnapshot;
    attempt: number;
  },
) =>
  | { nextConfig: OpenClawConfig; result?: unknown }
  | Promise<{ nextConfig: OpenClawConfig; result?: unknown }>;

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
  readVerifiedSnapshot: vi.fn<() => Promise<ConfigSnapshot>>(),
  readVerifiedSnapshotWithPluginMetadata: vi.fn(),
  commit: vi.fn(),
  configureGateway: vi.fn(),
  ensureWorkspace: vi.fn(),
  ensureGatewayService: vi.fn(),
  waitForGatewayReachable: vi.fn<() => Promise<{ ok: boolean; detail?: string }>>(),
  refreshPluginRegistry: vi.fn(),
  updateExecApprovals: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  verifySetupInferenceConfig: vi.fn(),
}));

vi.mock("../commands/onboard-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-agent.js")>()),
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("./setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verifySetupInferenceConfig,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readVerifiedSnapshot,
  readConfigFileSnapshotWithPluginMetadata: mocks.readVerifiedSnapshotWithPluginMetadata,
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
  resolveLocalControlUiProbeLinks: ({ port }: { port: number }) => ({
    wsUrl: `ws://127.0.0.1:${port}`,
  }),
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  transformConfigWithPendingPluginInstalls: mocks.commit,
}));

vi.mock("../wizard/setup.gateway-config.js", () => ({
  configureGatewayForSetup: mocks.configureGateway,
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

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentDir: (config: OpenClawConfig, agentId: string) =>
    resolveAgentEntry(config, agentId)?.agentDir ?? `/agents/${agentId}`,
}));

export function getSetupApplyMocks() {
  return mocks;
}

export const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

export function snapshot(
  hash: string | null,
  sourceConfig: OpenClawConfig,
  runtimeConfig: OpenClawConfig = sourceConfig,
): ConfigSnapshot {
  return {
    exists: hash !== null,
    valid: true,
    path: "/tmp/openclaw.json",
    hash,
    parsed: structuredClone(sourceConfig),
    sourceConfigBeforeMigrations: structuredClone(sourceConfig),
    config: runtimeConfig,
    sourceConfig: runtimeConfig,
    runtimeConfig,
    issues: [],
  };
}

export function codexPluginMetadataSnapshot(homeScope: "agent" | "user") {
  return {
    manifestRegistry: {
      diagnostics: [],
      plugins: [
        {
          id: "codex",
          origin: "global",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          settingsFiles: [],
          hooks: [],
          rootDir: "/tmp/codex",
          source: "/tmp/codex/index.js",
          manifestPath: "/tmp/codex/openclaw.plugin.json",
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              codexDynamicToolsLoading: { type: "string", default: "searchable" },
              appServer: {
                type: "object",
                additionalProperties: false,
                properties: {
                  transport: { type: "string", default: "stdio" },
                  homeScope: { type: "string", default: homeScope },
                  requestTimeoutMs: { type: "number", default: 60_000 },
                },
              },
            },
          },
        },
      ],
    },
  } as never;
}

export function materializePluginDefaults(
  config: OpenClawConfig,
  pluginMetadataSnapshot: ReturnType<typeof codexPluginMetadataSnapshot>,
): OpenClawConfig {
  const result = configModule.validateConfigObjectWithPlugins(config, { pluginMetadataSnapshot });
  if (!result.ok) {
    throw new Error(result.issues[0]?.message ?? "test config failed validation");
  }
  return result.config;
}

export function baseParams(
  overrides: Partial<Parameters<typeof import("./setup-apply.js").applySystemAgentSetup>[0]> = {},
) {
  return {
    workspace: "/tmp/openclaw-workspace",
    surface: "gateway" as const,
    runtime,
    ...overrides,
  };
}

export function mainAgentModelConfig(model = "openai/gpt-5.5"): OpenClawConfig {
  return { agents: { defaults: { model }, entries: { main: { default: true } } } };
}

export function setSetupCommitState(config: OpenClawConfig, initialSnapshot: ConfigSnapshot): void {
  mocks.state.initialSnapshot = initialSnapshot;
  mocks.state.commitConfig = config;
  mocks.state.commitSnapshot = initialSnapshot;
}
