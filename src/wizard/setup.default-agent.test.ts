// Classic setup tests keep every workspace-owned effect on the configured default agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
  writeConfig: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  setupSkills: vi.fn(),
  setupOfficialPlugins: vi.fn(),
  setupRecommendations: vi.fn(),
  setupPluginConfig: vi.fn(),
  finalizeSetup: vi.fn(),
}));

vi.mock("./navigation-prompter.js", () => ({
  runWizardWithPromptNavigation: async (
    prompter: WizardPrompter,
    run: (prompter: WizardPrompter) => Promise<void>,
  ) => await run(prompter),
}));

vi.mock("./setup.shared.js", () => ({
  readSetupConfigFileSnapshot: mocks.readSnapshot,
  readValidSetupConfigFile: vi.fn(),
  requireRiskAcknowledgement: async ({ config }: { config: OpenClawConfig }) => config,
  resolveQuickstartGatewayDefaults: () => ({
    hasExisting: false,
    port: 18789,
    bind: "loopback",
    authMode: "token",
    tailscaleMode: "off",
  }),
  writeWizardConfigFile: mocks.writeConfig,
}));

vi.mock("./setup.migration-import.js", () => ({
  detectSetupMigrationSources: vi.fn(async () => []),
  listSetupMigrationOptions: vi.fn(async () => []),
  runSetupMigrationImport: vi.fn(),
}));

vi.mock("./setup.model-auth.js", () => ({
  runSetupModelAuthStep: async ({ config }: { config: OpenClawConfig }) => ({
    config,
    authProfiles: [],
    persistAuthProfiles: async () => {},
  }),
}));

vi.mock("./setup.workspace.js", () => ({
  resolveSetupWorkspaceSelection: async () => ({
    workspaceDir: "/tmp/global-workspace",
    allowWorkspaceChange: false,
  }),
}));

vi.mock("./setup.secret-input.js", () => ({
  resolveSetupSecretInputString: vi.fn(async () => undefined),
}));

vi.mock("./setup.gateway-config.js", () => ({
  configureGatewayForSetup: async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
    nextConfig,
    settings: {
      port: 18789,
      bind: "loopback",
      authMode: "token",
      gatewayToken: "test-token",
      tailscaleMode: "off",
      tailscaleResetOnExit: false,
    },
  }),
}));

vi.mock("./setup.memory-import.js", () => ({
  runSetupMemoryImportStep: vi.fn(),
}));

vi.mock("./setup.official-plugins.js", () => ({
  setupOfficialPluginInstalls: mocks.setupOfficialPlugins,
}));

vi.mock("./setup.app-recommendations.js", () => ({
  setupAppRecommendations: mocks.setupRecommendations,
}));

vi.mock("./setup.plugin-config.js", () => ({
  setupPluginConfig: mocks.setupPluginConfig,
}));

vi.mock("./setup.finalize.js", () => ({
  finalizeSetupWizard: mocks.finalizeSetup,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  printWizardHeader: vi.fn(),
  probeGatewayReachable: vi.fn(async () => ({ ok: false })),
  summarizeExistingConfig: vi.fn(() => ""),
}));

vi.mock("../commands/onboard-skills.js", () => ({ setupSkills: mocks.setupSkills }));
vi.mock("../config/config.js", () => ({ resolveGatewayPort: () => 18789 }));
vi.mock("../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));
vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices: vi.fn(() => []),
  formatPluginCompatibilityNotice: vi.fn(),
}));

import { runSetupWizard } from "./setup.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

const prompter = {
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
} as unknown as WizardPrompter;

describe("runSetupWizard default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const config = {
      wizard: { securityAcknowledgedAt: "2026-07-01T00:00:00.000Z" },
      agents: {
        defaults: { workspace: "/tmp/global-workspace" },
        entries: {
          ops: {
            default: true,
            agentDir: "/tmp/ops-agent",
            workspace: "/tmp/ops-workspace",
          },
        },
      },
    } satisfies OpenClawConfig;
    mocks.readSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
      issues: [],
    });
    mocks.writeConfig.mockImplementation(async (nextConfig: OpenClawConfig) => nextConfig);
    mocks.setupSkills.mockImplementation(async (nextConfig: OpenClawConfig) => nextConfig);
    mocks.setupOfficialPlugins.mockImplementation(
      async ({ config: nextConfig }: { config: OpenClawConfig }) => nextConfig,
    );
    mocks.setupRecommendations.mockImplementation(
      async ({ config: nextConfig }: { config: OpenClawConfig }) => ({ config: nextConfig }),
    );
    mocks.setupPluginConfig.mockImplementation(
      async ({ config: nextConfig }: { config: OpenClawConfig }) => nextConfig,
    );
    mocks.finalizeSetup.mockResolvedValue({ launchedTui: false });
  });

  it("uses the keyed default-agent workspace for all classic agent-owned effects", async () => {
    await runSetupWizard(
      {
        acceptRisk: true,
        flow: "advanced",
        mode: "local",
        workspace: "/tmp/global-workspace",
        authChoice: "skip",
        installDaemon: false,
        skipChannels: true,
        skipSearch: true,
        skipHealth: true,
        skipHooks: true,
        skipUi: true,
      },
      runtime,
      prompter,
    );

    expect(mocks.writeConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({ workspace: "/tmp/global-workspace" }),
        }),
      }),
      expect.any(Object),
    );
    const target = {
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      workspaceDir: "/tmp/ops-workspace",
    };
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      target.workspaceDir,
      runtime,
      expect.objectContaining({ agentId: target.agentId }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      target.workspaceDir,
      runtime,
      prompter,
      expect.any(Object),
    );
    expect(mocks.setupOfficialPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: target.workspaceDir }),
    );
    expect(mocks.setupRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: target.workspaceDir }),
    );
    expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: target.workspaceDir }),
    );
    expect(mocks.finalizeSetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: target.workspaceDir }),
    );
  });
});
