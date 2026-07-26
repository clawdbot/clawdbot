// Configure wizard tests keep workspace-owned effects on the configured default agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  state: { snapshot: undefined as unknown },
  commitConfig: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  setupPluginConfig: vi.fn(),
  setupSkills: vi.fn(),
  text: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  createConfigIO: () => ({
    readConfigFileSnapshotForWrite: async () => ({ snapshot: mocks.state.snapshot }),
  }),
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: mocks.state.snapshot,
    writeOptions: {
      expectedConfigPath: "/tmp/openclaw.json",
      ownedConfigPathForWrite: "/tmp/openclaw.json",
    },
  }),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));

vi.mock("../plugins/install-record-commit.js", () => ({
  commitConfigWithPendingPluginInstalls: mocks.commitConfig,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  }),
}));

vi.mock("../wizard/setup.plugin-config.js", () => ({
  configurePluginConfig: mocks.setupPluginConfig,
}));

vi.mock("./configure.shared.js", () => ({
  CONFIGURE_SECTION_OPTIONS: [],
  confirm: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  select: vi.fn(),
  text: mocks.text,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  guardCancel: (value: unknown) => value,
  probeGatewayReachable: vi.fn(),
  resolveAdvertisedControlUiLinks: vi.fn(),
  resolveLocalControlUiProbeLinks: vi.fn(),
  summarizeExistingConfig: vi.fn(() => ""),
  waitForGatewayReachable: vi.fn(),
}));

vi.mock("./onboard-skills.js", () => ({ setupSkills: mocks.setupSkills }));

import { runConfigureWizard } from "./configure.wizard.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

describe("runConfigureWizard default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const baseConfig = {
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
    mocks.state.snapshot = {
      exists: true,
      valid: true,
      hash: "config-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
      issues: [],
    };
    mocks.text.mockResolvedValue("/tmp/new-ops-workspace");
    mocks.setupPluginConfig.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => config,
    );
    mocks.setupSkills.mockImplementation(async (config: OpenClawConfig) => config);
    mocks.commitConfig.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({ config: nextConfig }),
    );
  });

  it("uses the concrete default-agent workspace for provisioning, plugins, and skills", async () => {
    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills"] },
      runtime,
    );

    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ workspace: "/tmp/global-workspace" }),
            entries: expect.objectContaining({
              ops: expect.objectContaining({ workspace: "/tmp/new-ops-workspace" }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.setupPluginConfig).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/new-ops-workspace" }),
    );
    expect(mocks.setupSkills).toHaveBeenCalledWith(
      expect.any(Object),
      "/tmp/new-ops-workspace",
      runtime,
      expect.any(Object),
    );
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/new-ops-workspace",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
  });

  it("does not persist an unprovisionable workspace", async () => {
    mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));

    await expect(
      runConfigureWizard(
        { command: "configure", sections: ["workspace", "plugins", "skills"] },
        runtime,
      ),
    ).rejects.toThrow("workspace is unwritable");

    expect(mocks.setupPluginConfig).not.toHaveBeenCalled();
    expect(mocks.setupSkills).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
  });
});
