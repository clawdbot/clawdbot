// Non-interactive setup tests keep provisioning and output on the configured default agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  applyGatewayConfig: vi.fn(),
  commitConfig: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  ensureWorkspaceAndSessions: vi.fn(),
  inferAuthChoice: vi.fn(),
  logConfigUpdated: vi.fn(),
  logJson: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  resolveGatewayPort: () => 18789,
}));

vi.mock("../../config/logging.js", () => ({
  logConfigUpdated: mocks.logConfigUpdated,
}));

vi.mock("../onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/default-workspace",
  applyWizardMetadata: (config: OpenClawConfig) => config,
  ensureWorkspaceAndSessions: mocks.ensureWorkspaceAndSessions,
  resolveLocalControlUiProbeLinks: vi.fn(),
  waitForGatewayReachable: vi.fn(),
}));

vi.mock("./config-write.js", () => ({
  commitNonInteractiveOnboardConfig: mocks.commitConfig,
}));

vi.mock("../onboard-agent.js", () => ({
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("./local/auth-choice.js", () => ({
  applyNonInteractiveAuthChoice: mocks.applyAuthChoice,
}));

vi.mock("./local/auth-choice-inference.js", () => ({
  inferAuthChoiceFromFlags: mocks.inferAuthChoice,
}));

vi.mock("./local/gateway-config.js", () => ({
  applyNonInteractiveGatewayConfig: mocks.applyGatewayConfig,
}));

vi.mock("./local/output.js", () => ({
  logNonInteractiveOnboardingFailure: vi.fn(),
  logNonInteractiveOnboardingJson: mocks.logJson,
}));

vi.mock("./local/skills-config.js", () => ({
  applyNonInteractiveSkillsConfig: ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
}));

import { runNonInteractiveLocalSetup } from "./local.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

describe("runNonInteractiveLocalSetup default-agent ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.applyAuthChoice.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
    );
    mocks.applyGatewayConfig.mockImplementation(
      ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
        nextConfig,
        port: 18789,
        bind: "loopback",
        authMode: "token",
        tailscaleMode: "off",
      }),
    );
    mocks.commitConfig.mockImplementation(
      async ({ nextConfig }: { nextConfig: OpenClawConfig }) => nextConfig,
    );
    mocks.ensureOnboardingAgent.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({
        config,
        agentId: "ops",
        bootstrapPending: false,
      }),
    );
    mocks.inferAuthChoice.mockReturnValue({ matches: [] });
  });

  it("rejects ambiguous provider flags before creating an agent or writing setup state", async () => {
    mocks.inferAuthChoice.mockReturnValue({
      matches: [
        { optionKey: "openaiApiKey", authChoice: "openai-api-key", label: "--openai-api-key" },
        {
          optionKey: "anthropicApiKey",
          authChoice: "anthropic-api-key",
          label: "--anthropic-api-key",
        },
      ],
    });

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        openaiApiKey: "openai-test-key",
        anthropicApiKey: "anthropic-test-key",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Multiple API key flags were provided"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.applyGatewayConfig).not.toHaveBeenCalled();
    expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
    expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
  });

  it("resolves provider auth in the requested first-agent workspace before creating state", async () => {
    const workspace = "/tmp/requested-provider-workspace";
    mocks.ensureOnboardingAgent.mockImplementationOnce(
      async ({ config }: { config: OpenClawConfig }) => ({
        config: {
          ...config,
          agents: {
            ...config.agents,
            entries: { main: { default: true, workspace } },
          },
        },
        agentId: "main",
        bootstrapPending: true,
      }),
    );

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        workspace,
        authChoice: "demo-api-key",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(mocks.applyAuthChoice).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({ defaults: expect.objectContaining({ workspace }) }),
        }),
        target: expect.objectContaining({ agentId: "main", workspaceDir: workspace }),
      }),
    );
    expect(mocks.applyAuthChoice.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!,
    );
    expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ firstAgent: { name: "main" } }),
    );
    expect(mocks.commitConfig.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.ensureOnboardingAgent.mock.invocationCallOrder[0]!,
    );
  });

  it("passes an explicit first-agent name into the single creation step", async () => {
    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        agentName: "robby",
        authChoice: "skip",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(mocks.ensureOnboardingAgent).toHaveBeenCalledOnce();
    expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ firstAgent: { name: "robby" } }),
    );
  });

  it("rejects invalid gateway options before provider auth or first-agent creation", async () => {
    mocks.applyGatewayConfig.mockReturnValue(null);

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        authChoice: "demo-api-key",
        gatewayPort: 70_000,
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
      },
      runtime,
      baseConfig: {},
    });

    expect(mocks.applyGatewayConfig).toHaveBeenCalledOnce();
    expect(mocks.applyAuthChoice).not.toHaveBeenCalled();
    expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspaceAndSessions).not.toHaveBeenCalled();
  });

  it("does not publish config when the existing agent workspace cannot be provisioned", async () => {
    mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));

    await expect(
      runNonInteractiveLocalSetup({
        opts: {
          nonInteractive: true,
          mode: "local",
          authChoice: "skip",
          skipHooks: true,
          skipSkills: true,
          skipHealth: true,
        },
        runtime,
        baseConfig: { agents: { entries: { ops: { default: true } } } },
      }),
    ).rejects.toThrow("workspace is unwritable");

    expect(mocks.commitConfig).not.toHaveBeenCalled();
    expect(mocks.logConfigUpdated).not.toHaveBeenCalled();
  });

  it("provisions and reports the keyed default agent while preserving the global workspace", async () => {
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

    await runNonInteractiveLocalSetup({
      opts: {
        nonInteractive: true,
        mode: "local",
        workspace: "/tmp/global-workspace",
        authChoice: "skip",
        skipHooks: true,
        skipSkills: true,
        skipHealth: true,
        installDaemon: false,
        json: true,
      },
      runtime,
      baseConfig,
    });

    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ workspace: "/tmp/global-workspace" }),
          }),
        }),
      }),
    );
    expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
      "/tmp/ops-workspace",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(mocks.logJson).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/ops-workspace" }),
    );
  });
});
