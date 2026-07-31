// Register setup tests cover setup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSetupCommand } from "./register.setup.js";

const mocks = vi.hoisted(() => ({
  setupCommandMock: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupCommandMock = mocks.setupCommandMock;
const setupWizardCommandMock = mocks.setupWizardCommandMock;
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
  });

  it("runs setup wizard command by default", async () => {
    await runCli(["setup", "--workspace", "/tmp/ws"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.workspace).toBe("/tmp/ws");
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("runs baseline setup command when --baseline is set", async () => {
    await runCli(["setup", "--baseline", "--workspace", "/tmp/ws"]);

    expect(setupCommandMock).toHaveBeenCalledWith(lastSetupOptions(), runtime);
    expect(lastSetupOptions()?.workspace).toBe("/tmp/ws");
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("requires --accept-risk for --baseline --non-interactive", async () => {
    await runCli(["setup", "--baseline", "--non-interactive", "--workspace", "/tmp/ws"]);

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("runs --baseline --non-interactive when --accept-risk is given", async () => {
    await runCli([
      "setup",
      "--baseline",
      "--non-interactive",
      "--accept-risk",
      "--workspace",
      "/tmp/ws",
    ]);

    expect(setupCommandMock).toHaveBeenCalledWith(lastSetupOptions(), runtime);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("runs setup wizard command when --wizard is set", async () => {
    await runCli(["setup", "--wizard", "--mode", "remote", "--remote-url", "wss://example"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.mode).toBe("remote");
    expect(lastWizardOptions()?.remoteUrl).toBe("wss://example");
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

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
