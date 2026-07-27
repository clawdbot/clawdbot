// Onboard command tests cover guided setup entrypoints, setup aliases, and CLI messaging.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { setupWizardCommand } from "./onboard.js";

type ConfigSnapshotStub = {
  exists: boolean;
  valid: boolean;
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
};

type ProviderAuthMethodNonInteractiveValidationContext = Parameters<
  NonNullable<ProviderAuthMethod["validateNonInteractive"]>
>[0];

const mocks = vi.hoisted(() => ({
  runInteractiveSetup: vi.fn(async () => {}),
  runGuidedOnboarding: vi.fn(async () => {}),
  runNonInteractiveSetup: vi.fn(async () => {}),
  resolvePluginProviders: vi.fn(() => [
    {
      id: "anthropic",
      label: "Anthropic",
      auth: [
        {
          id: "setup-token",
          label: "Setup token",
          kind: "token",
          wizard: { choiceId: "setup-token" },
          run: vi.fn(),
          runNonInteractive: vi.fn(),
          validateNonInteractive: vi.fn(
            async (ctx: ProviderAuthMethodNonInteractiveValidationContext) => {
              if (ctx.opts.tokenExpiresIn === "nope") {
                ctx.runtime.error("Invalid --token-expires-in: invalid duration");
                ctx.runtime.exit(1);
                return false;
              }
              return Boolean(ctx.opts.token);
            },
          ),
        },
        {
          id: "api-key",
          label: "API key",
          kind: "api_key",
          wizard: { choiceId: "apiKey" },
          run: vi.fn(),
          runNonInteractive: vi.fn(),
          validateNonInteractive: vi.fn(
            async (ctx: ProviderAuthMethodNonInteractiveValidationContext) =>
              Boolean(
                await ctx.resolveApiKey({
                  provider: "anthropic",
                  flagValue:
                    typeof ctx.opts.anthropicApiKey === "string"
                      ? ctx.opts.anthropicApiKey
                      : undefined,
                  flagName: "--anthropic-api-key",
                  envVar: "ANTHROPIC_API_KEY",
                }),
              ),
          ),
        },
      ],
    },
  ]),
  readConfigFileSnapshot: vi.fn<() => Promise<ConfigSnapshotStub>>(async () => ({
    exists: false,
    valid: false,
    config: {},
  })),
  handleReset: vi.fn(async () => {}),
}));

vi.mock("./onboard-interactive.js", () => ({
  runInteractiveSetup: mocks.runInteractiveSetup,
}));

vi.mock("./onboard-guided.js", () => ({
  runGuidedOnboarding: mocks.runGuidedOnboarding,
}));

vi.mock("./onboard-non-interactive.js", () => ({
  runNonInteractiveSetup: mocks.runNonInteractiveSetup,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: () => 18_789,
}));

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("./onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./onboard-helpers.js")>()),
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  handleReset: mocks.handleReset,
}));

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

function expectResetCall(params: { scope: string; runtime: RuntimeEnv; workspace?: string }): void {
  const calls = mocks.handleReset.mock.calls as unknown as Array<[string, string, RuntimeEnv]>;
  const call = calls[0];
  if (!call) {
    throw new Error("expected handleReset call");
  }
  expect(call[0]).toBe(params.scope);
  if (params.workspace) {
    expect(call[1]).toBe(params.workspace);
  } else {
    expect(typeof call[1]).toBe("string");
  }
  expect(call[2]).toBe(params.runtime);
}

describe("setupWizardCommand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({ exists: false, valid: false, config: {} });
  });

  it("fails fast for invalid secret-input-mode before setup starts", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        secretInputMode: "invalid" as never, // pragma: allowlist secret
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --secret-input-mode. Use "plaintext" or "ref", or run ${formatCliCommand("openclaw onboard")} for the interactive setup.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("logs ASCII-safe Windows guidance before setup", async () => {
    const runtime = makeRuntime();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      await setupWizardCommand({}, runtime);

      expect(runtime.log).toHaveBeenCalledWith(
        [
          "Windows detected - OpenClaw runs great on WSL2!",
          "Native Windows might be trickier.",
          "Quick setup: wsl --install (one command, one reboot)",
          "Guide: https://docs.openclaw.ai/windows",
        ].join("\n"),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("defaults --reset to config+creds+sessions scope", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
      },
      runtime,
    );

    expectResetCall({ scope: "config+creds+sessions", runtime });
  });

  it("uses configured default workspace for --reset when --workspace is not provided", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/openclaw-custom-workspace",
          },
        },
      },
    });

    await setupWizardCommand(
      {
        reset: true,
      },
      runtime,
    );

    expect(mocks.handleReset).toHaveBeenCalledWith(
      "config+creds+sessions",
      path.resolve("/tmp/openclaw-custom-workspace"),
      runtime,
    );
  });

  it("uses the parsed workspace for a full reset when the config schema is invalid", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      sourceConfig: {
        agents: {
          defaults: {
            workspace: "/tmp/openclaw-invalid-config-workspace",
          },
        },
      },
    });

    await setupWizardCommand(
      {
        reset: true,
        resetScope: "full",
      },
      runtime,
    );

    expect(mocks.handleReset).toHaveBeenCalledWith(
      "full",
      path.resolve("/tmp/openclaw-invalid-config-workspace"),
      runtime,
    );
    expect(mocks.handleReset).not.toHaveBeenCalledWith(
      "full",
      path.resolve("~/.openclaw/workspace"),
      runtime,
    );
  });

  it("does not fall back to the default workspace when invalid config names no valid path", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      sourceConfig: {
        agents: {
          defaults: {
            workspace: 42,
          },
        },
      } as unknown as OpenClawConfig,
    });

    await setupWizardCommand(
      {
        reset: true,
        resetScope: "full",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Configured workspace is invalid. Pass --workspace with the workspace to remove, or use a narrower --reset-scope.",
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
  });

  it("requires an explicit workspace for a full reset when config is unreadable", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
    });

    await setupWizardCommand(
      {
        reset: true,
        resetScope: "full",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Cannot determine the configured workspace from an unreadable config. Pass --workspace with the workspace to remove, or use a narrower --reset-scope.",
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
  });

  it("accepts explicit --reset-scope full", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        resetScope: "full",
      },
      runtime,
    );

    expectResetCall({ scope: "full", runtime });
  });

  it("fails fast for invalid --reset-scope", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        resetScope: "invalid" as never,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --reset-scope. Use "config", "config+creds+sessions", or "full". Run ${formatCliCommand("openclaw onboard --reset --reset-scope config")} for a config-only reset.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("fails fast for invalid non-interactive --mode before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        mode: "typo" as never,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --mode "typo". Use "local" or "remote", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("fails fast for an empty non-interactive --mode before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        mode: "" as never,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      `Invalid --mode "". Use "local" or "remote", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
  });

  it("validates a remote URL before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        mode: "remote",
        remoteUrl: "https://example.com",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(expect.any(String));
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "unsupported flow",
      options: { flow: "bogus" as never },
      expectedError: "Invalid --flow",
    },
    {
      label: "malformed remote URL",
      options: { mode: "remote" as const, remoteUrl: "garbage" },
      expectedError: "URL must start with ws:// or wss://",
    },
    {
      label: "non-WebSocket remote URL",
      options: { mode: "remote" as const, remoteUrl: "https://example.invalid" },
      expectedError: "URL must start with ws:// or wss://",
    },
    {
      label: "unsupported daemon runtime while daemon install is skipped",
      options: { daemonRuntime: "bogus" as never, installDaemon: false },
      expectedError: "Invalid --daemon-runtime",
    },
    {
      label: "unsupported node manager",
      options: { nodeManager: "bogus" as never },
      expectedError: "Invalid --node-manager",
    },
  ])(
    "rejects $label before non-interactive setup without reset",
    async ({ options, expectedError }) => {
      const runtime = makeRuntime();

      await setupWizardCommand({ nonInteractive: true, acceptRisk: true, ...options }, runtime);

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(expectedError));
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mocks.handleReset).not.toHaveBeenCalled();
      expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
      expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
      expect(mocks.runGuidedOnboarding).not.toHaveBeenCalled();
    },
  );

  it("validates dependent gateway options before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        gatewayAuth: "password",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Missing --gateway-password for password auth. Pass --gateway-password or use --gateway-auth token.",
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates gateway token env refs before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        gatewayTokenRefEnv: "MISSING_GATEWAY_TOKEN_ENV",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('Environment variable "MISSING_GATEWAY_TOKEN_ENV" is missing'),
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
  });

  it("rejects conflicting gateway token inputs before reset", async () => {
    const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    const runtime = makeRuntime();

    try {
      await setupWizardCommand(
        {
          reset: true,
          gatewayToken: "plaintext-token",
          gatewayTokenRefEnv: "OPENCLAW_GATEWAY_TOKEN",
        },
        runtime,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      } else {
        process.env.OPENCLAW_GATEWAY_TOKEN = previous;
      }
    }

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Use either --gateway-token or --gateway-token-ref-env"),
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates dependent auth-choice options before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        authChoice: "token",
        token: "value",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      'Auth choice "token" requires --token-provider in non-interactive setup.',
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates a required setup token before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        authChoice: "setup-token",
        tokenProvider: "anthropic",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      'Auth choice "setup-token" requires --token in non-interactive setup.',
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates setup-token expiry before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        authChoice: "setup-token",
        tokenProvider: "anthropic",
        token: "test-token",
        tokenExpiresIn: "nope",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith("Invalid --token-expires-in: invalid duration");
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates the token provider before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        authChoice: "token",
        tokenProvider: "typo",
        token: "value",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      'Auth choice "token" was not matched to provider "typo".',
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates a provider-specific API key before reset", async () => {
    const runtime = makeRuntime();
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        authChoice: "apiKey",
        tokenProvider: "anthropic",
        anthropicApiKey: "",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      `Missing --anthropic-api-key (or ANTHROPIC_API_KEY in env). Export ANTHROPIC_API_KEY, pass --anthropic-api-key, or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates an inferred custom auth choice before reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        customBaseUrl: "https://example.com/v1",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      [
        'Auth choice "custom-api-key" requires a base URL and model ID.',
        "Use --custom-base-url and --custom-model-id.",
      ].join("\n"),
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("validates custom credential storage before reset", async () => {
    const runtime = makeRuntime();
    vi.stubEnv("CUSTOM_API_KEY", "");

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        customBaseUrl: "https://example.com/v1",
        customModelId: "test-model",
        customApiKey: "test-token",
        secretInputMode: "ref",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      [
        "--custom-api-key cannot be used with --secret-input-mode ref unless CUSTOM_API_KEY is set in env.",
        "Set CUSTOM_API_KEY in env and omit --custom-api-key, or use --secret-input-mode plaintext.",
      ].join("\n"),
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("rejects migration import before reset because provider input is not preplanned", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        flow: "import",
        importFrom: "hermes",
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(
      "Migration import cannot be combined with --reset because provider input must be planned before any state is removed. Run the import without --reset.",
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("routes flagless interactive onboarding to the guided flow", async () => {
    const runtime = makeRuntime();

    // Unset Commander booleans arrive as false and must not force classic.
    await setupWizardCommand(
      { skipChannels: false, skipSkills: false, acceptRisk: false, json: false },
      runtime,
    );

    expect(mocks.runGuidedOnboarding).toHaveBeenCalledOnce();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("keeps --tui on guided onboarding", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand({ tui: true }, runtime);

    expect(mocks.runGuidedOnboarding).toHaveBeenCalledWith({ tui: true }, runtime);
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
  });

  it.each([
    ["--classic", { classic: true }],
    ["--flow quickstart", { flow: "quickstart" as const }],
    ["--mode remote", { mode: "remote" as const }],
    ["--import-from", { importFrom: "hermes" }],
    ["--auth-choice", { authChoice: "skip" }],
    ["--gateway-port", { gatewayPort: 19001 }],
    ["--remote-url", { remoteUrl: "wss://gw.example.ts.net" }],
    ["--skip-bootstrap", { skipBootstrap: true }],
    ["--no-install-daemon", { installDaemon: false }],
    ["--daemon-runtime", { daemonRuntime: "node" as const }],
    ["a provider auth flag", { mistralApiKey: "sk-x" }],
  ])("keeps the classic interactive wizard for %s", async (_label, opts) => {
    const runtime = makeRuntime();

    await setupWizardCommand(opts, runtime);

    expect(mocks.runInteractiveSetup).toHaveBeenCalledOnce();
    expect(mocks.runGuidedOnboarding).not.toHaveBeenCalled();
  });

  it("keeps non-interactive routing unchanged", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand({ nonInteractive: true, acceptRisk: true }, runtime);

    expect(mocks.runNonInteractiveSetup).toHaveBeenCalledOnce();
    expect(mocks.runGuidedOnboarding).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
  });

  it("rejects conflicting classic and non-interactive modes", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand({ classic: true, nonInteractive: true, acceptRisk: true }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--classic cannot be combined with --non-interactive. Remove --non-interactive to open the classic wizard, or remove --classic for automated setup.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runGuidedOnboarding).not.toHaveBeenCalled();
  });
});
