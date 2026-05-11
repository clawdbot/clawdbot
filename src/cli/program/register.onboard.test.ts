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

  function setupWizardOptions(callIndex = 0): Record<string, unknown> {
    const call = setupWizardCommandMock.mock.calls[callIndex];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error(`expected setup wizard call ${callIndex}`);
    }
    expect(call[1]).toBe(runtime);
    return call[0] as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runCrestodian.mockResolvedValue(undefined);
    setupWizardCommandMock.mockResolvedValue(undefined);
  });

  it("defaults installDaemon to undefined when no daemon flags are provided", async () => {
    await runCli(["onboard"]);

    expect(setupWizardOptions().installDaemon).toBeUndefined();
    expect(mocks.runCrestodian).not.toHaveBeenCalled();
  });

  it("sets installDaemon from explicit install flags and prioritizes --skip-daemon", async () => {
    await runCli(["onboard", "--install-daemon"]);
    expect(setupWizardOptions(0).installDaemon).toBe(true);

    await runCli(["onboard", "--no-install-daemon"]);
    expect(setupWizardOptions(1).installDaemon).toBe(false);

    await runCli(["onboard", "--install-daemon", "--skip-daemon"]);
    expect(setupWizardOptions(2).installDaemon).toBe(false);
  });

  it("parses numeric gateway port and drops invalid values", async () => {
    await runCli(["onboard", "--gateway-port", "18789"]);
    expect(setupWizardOptions(0).gatewayPort).toBe(18789);

    await runCli(["onboard", "--gateway-port", "nope"]);
    expect(setupWizardOptions(1).gatewayPort).toBeUndefined();
  });

  it("forwards --reset-scope to setup wizard options", async () => {
    await runCli(["onboard", "--reset", "--reset-scope", "full"]);
    const options = setupWizardOptions();
    expect(options.reset).toBe(true);
    expect(options.resetScope).toBe("full");
  });

  it("forwards --skip-bootstrap to setup wizard options", async () => {
    await runCli(["onboard", "--skip-bootstrap"]);
    expect(setupWizardOptions().skipBootstrap).toBe(true);
  });

  it("parses --mistral-api-key and forwards mistralApiKey", async () => {
    await runCli(["onboard", "--mistral-api-key", "sk-mistral-test"]);
    expect(setupWizardOptions().mistralApiKey).toBe("sk-mistral-test"); // pragma: allowlist secret
  });

  it("dedupes provider auth flags before registering command options", async () => {
    await runCli(["onboard", "--openai-api-key", "sk-openai-test"]);
    expect(setupWizardOptions().openaiApiKey).toBe("sk-openai-test"); // pragma: allowlist secret
  });

  it("forwards --gateway-token-ref-env", async () => {
    await runCli(["onboard", "--gateway-token-ref-env", "OPENCLAW_GATEWAY_TOKEN"]);
    expect(setupWizardOptions().gatewayTokenRefEnv).toBe("OPENCLAW_GATEWAY_TOKEN");
  });

  it("forwards onboarding migration flags", async () => {
    await runCli([
      "onboard",
      "--flow",
      "import",
      "--import-from",
      "hermes",
      "--import-source",
      "/tmp/hermes",
      "--import-secrets",
    ]);
    const options = setupWizardOptions();
    expect(options.flow).toBe("import");
    expect(options.importFrom).toBe("hermes");
    expect(options.importSource).toBe("/tmp/hermes");
    expect(options.importSecrets).toBe(true);
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
