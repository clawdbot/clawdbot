// Register setup tests cover setup command registration and option wiring.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerOnboardCommand } from "./register.onboard.js";
import { registerSetupCommand, resolveSetupCommandRoute } from "./register.setup.js";

const mocks = vi.hoisted(() => ({
  setupCommandMock: vi.fn(),
  setupWizardCommandMock: vi.fn(),
  runSystemAgentMock: vi.fn(),
  readConfigFileSnapshotMock: vi.fn(),
  readLocalOnboardingStateMock: vi.fn(),
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
const readLocalOnboardingStateMock = mocks.readLocalOnboardingStateMock;
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

vi.mock("../../state/local-onboarding-state.js", () => ({
  readLocalOnboardingStateForConfig: mocks.readLocalOnboardingStateMock,
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

  async function runInteractiveBareSetup() {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    try {
      await runCli(["setup"]);
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    readLocalOnboardingStateMock.mockReset();
    setupCommandMock.mockResolvedValue(undefined);
    setupWizardCommandMock.mockResolvedValue(undefined);
    runSystemAgentMock.mockResolvedValue(undefined);
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: false,
      valid: true,
      path: "/tmp/openclaw.json",
      sourceConfig: {},
    });
  });

  it("keeps shared onboarding flags aligned while preserving command-specific help", () => {
    const program = new Command();
    registerOnboardCommand(program);
    registerSetupCommand(program);
    const onboard = program.commands.find((command) => command.name() === "onboard")!;
    const setup = program.commands.find((command) => command.name() === "setup")!;
    const setupOptions = new Map(setup.options.map((option) => [option.flags, option]));
    const distinctHelp = new Set([
      "workspace",
      "reset",
      "nonInteractive",
      "skipUi",
      "skipHooks",
      "json",
    ]);

    for (const option of onboard.options) {
      const sibling = setupOptions.get(option.flags);
      if (!sibling) {
        continue;
      }
      expect([sibling.flags, sibling.defaultValue, sibling.hidden]).toEqual([
        option.flags,
        option.defaultValue,
        option.hidden,
      ]);
      if (!distinctHelp.has(option.attributeName())) {
        expect(sibling.description).toBe(option.description);
      }
    }

    const optionIndex = (command: Command, name: string) =>
      command.options.findIndex((option) => option.attributeName() === name);
    expect(optionIndex(onboard, "remoteUrl")).toBeLessThan(optionIndex(onboard, "tailscale"));
    expect(optionIndex(setup, "remoteUrl")).toBeGreaterThan(optionIndex(setup, "importSecrets"));
    expect(setupOptions.get("--tailscale-reset-on-exit")?.hidden).toBe(true);
    expect(setupOptions.get("--no-tailscale-reset-on-exit")?.hidden).toBe(true);
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
    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("resumes pending local onboarding instead of opening chat after inference commits", async () => {
    const sourceConfig = {
      agents: { defaults: { model: "acme/verified" } },
      wizard: { securityAcknowledgedAt: "2026-08-02T00:00:00.000Z" },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockReturnValue({ status: "pending" });

    await runInteractiveBareSetup();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith("/tmp/openclaw.json", sourceConfig);
    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(runSystemAgentMock).not.toHaveBeenCalled();
  });

  it.each(["full", "guarded"])(
    "resumes onboarding when interrupted after selecting %s access",
    async (accessMode) => {
      readConfigFileSnapshotMock.mockResolvedValue({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        sourceConfig: {
          $schema: "https://openclaw.ai/config.json",
          meta: { updatedBy: "fixture" },
          wizard: { securityAcknowledgedAt: "2026-08-02T00:00:00.000Z", accessMode },
        },
      });

      await runInteractiveBareSetup();

      expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
      expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
      expect(runSystemAgentMock).not.toHaveBeenCalled();
    },
  );

  it("keeps chat when other wizard settings prove the config is authored", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      sourceConfig: {
        wizard: {
          securityAcknowledgedAt: "2026-08-02T00:00:00.000Z",
          accessMode: "guarded",
          lastRunAt: "2026-08-02T00:00:00.000Z",
        },
      },
    });

    await runInteractiveBareSetup();

    expect(runSystemAgentMock).toHaveBeenCalledOnce();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["authored model without an onboarding receipt", undefined],
    ["completed local onboarding", { status: "completed" }],
  ])("keeps interactive chat for %s", async (_description, onboardingState) => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      sourceConfig: { agents: { defaults: { model: "acme/verified" } } },
    });
    readLocalOnboardingStateMock.mockReturnValue(onboardingState);

    await runInteractiveBareSetup();

    expect(runSystemAgentMock).toHaveBeenCalledWith(
      { message: undefined, yes: false, json: false },
      runtime,
    );
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("keeps chat when a pending receipt belongs to a replaced config", async () => {
    const sourceConfig = {
      agents: { defaults: { model: "acme/verified" } },
      wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
    };
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      sourceConfig,
    });
    readLocalOnboardingStateMock.mockImplementation((_configPath, config) =>
      config.wizard?.securityAcknowledgedAt === "2026-08-02T00:00:00.000Z"
        ? { status: "pending" }
        : undefined,
    );

    await runInteractiveBareSetup();

    expect(readLocalOnboardingStateMock).toHaveBeenCalledWith("/tmp/openclaw.json", sourceConfig);
    expect(runSystemAgentMock).toHaveBeenCalledOnce();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid config", { valid: false, sourceConfig: {} }],
    ["remote Gateway", { valid: true, sourceConfig: { gateway: { mode: "remote" } } }],
  ])("does not let a stale local receipt reroute %s", async (_description, config) => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      path: "/tmp/openclaw.json",
      ...config,
    });
    readLocalOnboardingStateMock.mockReturnValue({ status: "pending" });

    await runInteractiveBareSetup();

    expect(readLocalOnboardingStateMock).not.toHaveBeenCalled();
    expect(runSystemAgentMock).toHaveBeenCalledOnce();
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it("uses system overview JSON on configured systems", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
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
    expect(lastWizardOptions()).not.toHaveProperty("tailscaleResetOnExit");
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("accepts retired --no-tailscale-reset-on-exit as a no-op", async () => {
    await runCli(["setup", "--no-tailscale-reset-on-exit"]);

    expect(lastWizardOptions()).not.toHaveProperty("tailscaleResetOnExit");
  });

  it("accepts retired --tailscale-reset-on-exit as a no-op", async () => {
    await runCli(["setup", "--tailscale-reset-on-exit"]);

    expect(lastWizardOptions()).not.toHaveProperty("tailscaleResetOnExit");
  });

  it("runs baseline setup command when --baseline is set", async () => {
    await runCli(["setup", "--baseline", "--workspace", "/tmp/ws", "--json"]);

    expect(setupCommandMock).toHaveBeenCalledWith(lastSetupOptions(), runtime);
    expect(lastSetupOptions()?.workspace).toBe("/tmp/ws");
    expect(lastSetupOptions()?.json).toBe(true);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["onboarding mode", ["--mode", "remote"]],
    ["remote Gateway", ["--remote-url", "wss://example.invalid"]],
    ["remote Gateway password", ["--remote-password", "fixture-password"]],
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

  it.each([
    { flag: "--remote-token", optionKey: "remoteToken" },
    { flag: "--remote-password", optionKey: "remotePassword" },
  ])("forwards $flag to the setup wizard", async ({ flag, optionKey }) => {
    const credential = ["fixture", "value"].join("-");
    await runCli([
      "setup",
      "--wizard",
      "--mode",
      "remote",
      "--remote-url",
      "wss://example",
      flag,
      credential,
    ]);

    expect(setupWizardCommandMock).toHaveBeenCalledWith(lastWizardOptions(), runtime);
    expect(lastWizardOptions()?.mode).toBe("remote");
    expect(lastWizardOptions()?.remoteUrl).toBe("wss://example");
    expect(lastWizardOptions()?.[optionKey]).toBe(credential);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("forwards --tui through the canonical onboarding path", async () => {
    await runCli(["setup", "--tui"]);

    expect(lastWizardOptions()?.tui).toBe(true);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("forwards --skip-ui through the canonical onboarding path", async () => {
    await runCli(["setup", "--skip-ui"]);

    expect(lastWizardOptions()?.skipUi).toBe(true);
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it("rejects conflicting custom model input capabilities", async () => {
    await runCli(["setup", "--custom-image-input", "--custom-text-input"]);

    expect(runtime.error).toHaveBeenCalledWith(
      "Use either --custom-image-input or --custom-text-input, not both.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(setupWizardCommandMock).not.toHaveBeenCalled();
    expect(setupCommandMock).not.toHaveBeenCalled();
  });

  it.each(["not-a-port", "70000"])(
    "rejects invalid --gateway-port %s before onboarding dispatch",
    async (gatewayPort) => {
      await runCli(["setup", "--gateway-port", gatewayPort]);

      expect(runtime.error).toHaveBeenCalledWith(
        "--gateway-port must be an integer between 1 and 65535.",
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

  it.each([
    ["guided", ["--wizard"]],
    ["classic", ["--classic"]],
    ["non-interactive", ["--non-interactive", "--accept-risk"]],
  ])("forwards --agent-name through %s setup", async (_mode, modeArgs) => {
    await runCli([
      "setup",
      ...modeArgs,
      "--agent-name",
      "robby",
      "--workspace",
      "/tmp/robby",
      "--skip-bootstrap",
    ]);

    expect(lastWizardOptions()).toMatchObject({
      agentName: "robby",
      workspace: "/tmp/robby",
      skipBootstrap: true,
    });
    expect(setupCommandMock).not.toHaveBeenCalled();
    expect(runSystemAgentMock).not.toHaveBeenCalled();
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

    expect(runtime.error).toHaveBeenCalledWith("setup failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
