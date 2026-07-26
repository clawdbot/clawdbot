// Register setup tests cover setup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSetupCommand, resolveSetupCommandRoute } from "./register.setup.js";

const mocks = vi.hoisted(() => ({
  setupCommandMock: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  runSystemAgentMock: vi.fn(),
  readConfigFileSnapshotMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupCommandMock = mocks.setupCommandMock;
const setupWizardCommandMock = mocks.setupWizardCommandMock;
const runSystemAgentMock = mocks.runSystemAgentMock;
const readConfigFileSnapshotMock = mocks.readConfigFileSnapshotMock;
const runtime = mocks.runtime;

function lastSetupOptions(): Record<string, unknown> | undefined {
  const calls = setupCommandMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

function lastWizardOptions(): Record<string, unknown> | undefined {
  const calls = setupWizardCommandMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
}

vi.mock("../../commands/setup.js", () => ({
  setupCommand: mocks.setupCommandMock,
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: mocks.setupWizardCommandMock,
}));

vi.mock("../../commands/system-agent-with-inference.js", () => ({
  runSystemAgentWithInference: mocks.runSystemAgentMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshotMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerSetupCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSetupCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupCommandMock.mockResolvedValue(undefined);
    setupWizardCommandMock.mockResolvedValue(undefined);
    runSystemAgentMock.mockResolvedValue(undefined);
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: false,
      valid: true,
      sourceConfig: {},
    });
  });

  it("keeps routing precedence explicit", () => {
    expect(
      resolveSetupCommandRoute({
        hasOnboardingFlag: true,
        hasSystemAgentRequest: true,
        configured: true,
        interactive: true,
        json: true,
      }),
    ).toBe("onboarding");
    expect(
      resolveSetupCommandRoute({
        hasOnboardingFlag: false,
        hasSystemAgentRequest: true,
        configured: false,
        interactive: false,
        json: false,
      }),
    ).toBe("system-agent");
    expect(
      resolveSetupCommandRoute({
        hasOnboardingFlag: false,
        hasSystemAgentRequest: false,
        configured: true,
        interactive: true,
        json: false,
      }),
    ).toBe("system-agent");
    expect(
      resolveSetupCommandRoute({
        hasOnboardingFlag: false,
        hasSystemAgentRequest: false,
        configured: false,
        interactive: true,
        json: true,
      }),
    ).toBe("onboarding");
  });

  it("runs one-shot system-agent requests without probing config", async () => {
    await runCli(["setup", "-m", "status", "--yes"]);

    expect(runSystemAgentMock).toHaveBeenCalledWith(
      { message: "status", yes: true, json: false },
      runtime,
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("uses system overview JSON on configured systems", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: { gateway: {} },
    });

    await runCli(["setup", "--json"]);

    expect(runSystemAgentMock).toHaveBeenCalledWith(
      { message: undefined, yes: false, json: true },
      runtime,
    );
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("keeps onboarding JSON for unconfigured systems", async () => {
    await runCli(["setup", "--json"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.json).toBe(true);
    expect(runSystemAgentMock).not.toHaveBeenCalled();
  });

  it("registers a hidden retired-name alias", async () => {
    const program = new Command();
    registerSetupCommand(program);

    expect(program.helpInformation()).not.toContain("crestodian"); // hidden alias
    await program.parseAsync(["crestodian", "--message", "status"], { from: "user" }); // hidden alias
    expect(runSystemAgentMock).toHaveBeenCalledWith(
      { message: "status", yes: false, json: false },
      runtime,
    );
  });

  it("runs setup wizard command by default", async () => {
    await runCli(["setup", "--workspace", "/tmp/ws"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.workspace).toBe("/tmp/ws");
    expect(lastWizardOptions()?.tailscaleResetOnExit).toBeUndefined();
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("forwards explicit --no-tailscale-reset-on-exit", async () => {
    await runCli(["setup", "--no-tailscale-reset-on-exit"]);

    expect(lastWizardOptions()?.tailscaleResetOnExit).toBe(false);
  });

  it("runs baseline setup command when --baseline is set", async () => {
    await runCli(["setup", "--baseline", "--workspace", "/tmp/ws", "--json"]);

    expect(setupCommandMock).toHaveBeenCalledWith(lastSetupOptions(), runtime);
    expect(lastSetupOptions()?.workspace).toBe("/tmp/ws");
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["onboarding mode", ["--mode", "remote"]],
    ["remote Gateway", ["--remote-url", "wss://example.invalid"]],
    ["reset", ["--reset"]],
    ["daemon", ["--daemon-runtime", "node"]],
    ["auth", ["--auth-choice", "skip"]],
  ])("rejects explicit %s options with --baseline", async (_label, args) => {
    await runCli(["setup", "--baseline", ...args]);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(args[0]!));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when --wizard is set", async () => {
    const remoteToken = ["fixture", "value"].join("-");
    await runCli([
      "setup",
      "--wizard",
      "--mode",
      "remote",
      "--remote-url",
      "wss://example",
      "--remote-token",
      remoteToken,
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.mode).toBe("remote");
    expect(lastWizardOptions()?.remoteUrl).toBe("wss://example");
    expect(lastWizardOptions()?.remoteToken).toBe(remoteToken);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("forwards --tui through the canonical onboarding path", async () => {
    await runCli(["setup", "--tui"]);

    expect(lastWizardOptions()?.tui).toBe(true);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it.each(["not-a-port", "70000"])(
    "rejects invalid --gateway-port %s before onboarding dispatch",
    async (gatewayPort) => {
      await runCli(["setup", "--gateway-port", gatewayPort]);

      expect(runtime.error).toHaveBeenCalledWith(
        "Error: --gateway-port must be an integer between 1 and 65535.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(setupWizardCommandMock).not.toHaveBeenCalled();
      expect(setupCommandMock).not.toHaveBeenCalled();
    },
  );

  it("runs setup wizard command when wizard-only flags are passed explicitly", async () => {
    await runCli(["setup", "--mode", "remote", "--non-interactive", "--accept-risk"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.mode).toBe("remote");
    expect(lastWizardOptions()?.nonInteractive).toBe(true);
    expect(lastWizardOptions()?.acceptRisk).toBe(true);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("forwards scripted onboarding controls", async () => {
    await runCli([
      "setup",
      "--non-interactive",
      "--accept-risk",
      "--flow",
      "advanced",
      "--gateway-port",
      "18789",
      "--install-daemon",
      "--skip-daemon",
      "--skip-health",
      "--skip-ui",
      "--skip-channels",
      "--skip-search",
      "--skip-skills",
      "--skip-bootstrap",
      "--tailscale-reset-on-exit",
      "--node-manager",
      "pnpm",
      "--json",
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()).toMatchObject({
      nonInteractive: true,
      acceptRisk: true,
      flow: "advanced",
      gatewayPort: 18789,
      installDaemon: false,
      skipHealth: true,
      skipUi: true,
      skipChannels: true,
      skipSearch: true,
      skipSkills: true,
      skipBootstrap: true,
      tailscaleResetOnExit: true,
      nodeManager: "pnpm",
      json: true,
    });
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("forwards onboard auth flags through the setup alias", async () => {
    await runCli([
      "setup",
      "--non-interactive",
      "--accept-risk",
      "--auth-choice",
      "token",
      "--token-provider",
      "openai",
      "--token",
      "test-token",
      "--token-profile-id",
      "openai:manual",
      "--token-expires-in",
      "1d",
      "--secret-input-mode",
      "ref",
      "--openai-api-key",
      "test-openai-api-key",
      "--cloudflare-ai-gateway-account-id",
      "account-id",
      "--cloudflare-ai-gateway-gateway-id",
      "gateway-id",
      "--custom-base-url",
      "https://example.test/v1",
      "--custom-api-key",
      "test-custom-api-key",
      "--custom-model-id",
      "custom-model",
      "--custom-provider-id",
      "custom-provider",
      "--custom-compatibility",
      "anthropic",
      "--custom-text-input",
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()).toMatchObject({
      nonInteractive: true,
      acceptRisk: true,
      authChoice: "token",
      tokenProvider: "openai",
      token: "test-token",
      tokenProfileId: "openai:manual",
      tokenExpiresIn: "1d",
      secretInputMode: "ref",
      openaiApiKey: "test-openai-api-key",
      cloudflareAiGatewayAccountId: "account-id",
      cloudflareAiGatewayGatewayId: "gateway-id",
      customBaseUrl: "https://example.test/v1",
      customApiKey: "test-custom-api-key",
      customModelId: "custom-model",
      customProviderId: "custom-provider",
      customCompatibility: "anthropic",
      customImageInput: false,
    });
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("runs setup wizard command for migration import flags", async () => {
    await runCli([
      "setup",
      "--import-from",
      "hermes",
      "--import-source",
      "/tmp/hermes",
      "--import-secrets",
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.importFrom).toBe("hermes");
    expect(lastWizardOptions()?.importSource).toBe("/tmp/hermes");
    expect(lastWizardOptions()?.importSecrets).toBe(true);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("reports setup errors through runtime", async () => {
    setupWizardCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["setup"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
