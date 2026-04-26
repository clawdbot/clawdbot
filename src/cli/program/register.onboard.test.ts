import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerOnboardCommand } from "./register.onboard.js";

const mocks = vi.hoisted(() => ({
  runCrestodian: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const setupWizardCommandMock = mocks.setupWizardCommandMock;
const runtime = mocks.runtime;

vi.mock("../../commands/auth-choice-options.js", () => ({
  formatAuthChoiceChoicesForCli: () => "token|oauth|openai-api-key",
}));

vi.mock("../../commands/onboard-core-auth-flags.js", () => ({
  CORE_ONBOARD_AUTH_FLAGS: [
    {
      cliOption: "--mistral-api-key <key>",
      description: "Mistral API key",
      optionKey: "mistralApiKey",
    },
    {
      cliOption: "--openai-api-key <key>",
      description: "OpenAI API key (core fallback)",
      optionKey: "openaiApiKey",
    },
  ] as Array<{ cliOption: string; description: string; optionKey: string }>,
}));

vi.mock("../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderOnboardAuthFlags: () => [
    {
      cliOption: "--openai-api-key <key>",
      description: "OpenAI API key",
      optionKey: "openaiApiKey",
    },
  ],
}));

vi.mock("../../commands/onboard.js", () => ({
  setupWizardCommand: mocks.setupWizardCommandMock,
}));

vi.mock("../../crestodian/crestodian.js", () => ({
  runCrestodian: mocks.runCrestodian,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerOnboardCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerOnboardCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runCrestodian.mockResolvedValue(undefined);
    setupWizardCommandMock.mockResolvedValue(undefined);
  });

  it("defaults installDaemon to undefined when no daemon flags are provided", async () => {
    await runCli(["onboard"]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        installDaemon: undefined,
      }),
      runtime,
    );
    expect(mocks.runCrestodian).not.toHaveBeenCalled();
  });

  it("sets installDaemon from explicit install flags and prioritizes --skip-daemon", async () => {
    await runCli(["onboard", "--install-daemon"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        installDaemon: true,
      }),
      runtime,
    );

    await runCli(["onboard", "--no-install-daemon"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        installDaemon: false,
      }),
      runtime,
    );

    await runCli(["onboard", "--install-daemon", "--skip-daemon"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        installDaemon: false,
      }),
      runtime,
    );
  });

  it("parses numeric gateway port and drops invalid values", async () => {
    await runCli(["onboard", "--gateway-port", "18789"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        gatewayPort: 18789,
      }),
      runtime,
    );

    await runCli(["onboard", "--gateway-port", "nope"]);
    expect(setupWizardCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        gatewayPort: undefined,
      }),
      runtime,
    );
  });

  it("forwards --reset-scope to setup wizard options", async () => {
    await runCli(["onboard", "--reset", "--reset-scope", "full"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reset: true,
        resetScope: "full",
      }),
      runtime,
    );
  });

  it("forwards --skip-bootstrap to setup wizard options", async () => {
    await runCli(["onboard", "--skip-bootstrap"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        skipBootstrap: true,
      }),
      runtime,
    );
  });

  it("parses --mistral-api-key and forwards mistralApiKey", async () => {
    await runCli(["onboard", "--mistral-api-key", "sk-mistral-test"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mistralApiKey: "sk-mistral-test", // pragma: allowlist secret
      }),
      runtime,
    );
  });

  it("dedupes provider auth flags before registering command options", async () => {
    await runCli(["onboard", "--openai-api-key", "sk-openai-test"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        openaiApiKey: "sk-openai-test", // pragma: allowlist secret
      }),
      runtime,
    );
  });

  it("forwards --gateway-token-ref-env", async () => {
    await runCli(["onboard", "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN"]);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayTokenRefEnv: "OPENCLAW_GATEWAY_TOKEN",
      }),
      runtime,
    );
  });

  it("reports errors via runtime on setup wizard command failures", async () => {
    setupWizardCommandMock.mockRejectedValueOnce(new Error("setup failed"));

    await runCli(["onboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("routes --modern to Crestodian", async () => {
    await runCli(["onboard", "--modern", "--json"]);

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(mocks.runCrestodian).toHaveBeenCalledWith({
      message: undefined,
      yes: false,
      json: true,
      interactive: true,
    });
  });

  it("uses a noninteractive overview for modern noninteractive onboarding", async () => {
    await runCli(["onboard", "--modern", "--non-interactive"]);

    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(mocks.runCrestodian).toHaveBeenCalledWith({
      message: "overview",
      yes: false,
      json: false,
      interactive: false,
    });
  });
});
