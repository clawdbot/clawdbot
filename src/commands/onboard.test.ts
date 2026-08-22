// Onboard command tests cover guided setup entrypoints, setup aliases, and CLI messaging.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import * as nonInteractiveApiKeys from "./onboard-non-interactive/api-keys.js";
import { setupWizardCommand } from "./onboard.js";

type ConfigSnapshotStub = {
  exists: boolean;
  valid: boolean;
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  readError?: { code: string | null };
};

type ProviderAuthMethodNonInteractiveValidationContext = Parameters<
  NonNullable<ProviderAuthMethod["validateNonInteractive"]>
>[0];

const mocks = vi.hoisted(() => ({
  runInteractiveSetup: vi.fn(async () => {}),
  runGuidedOnboarding: vi.fn(async () => {}),
  runNonInteractiveSetup: vi.fn(async () => {}),
  hasInteractiveOnboardingTty: vi.fn(() => true),
  resolvePluginProviders: vi.fn((): ProviderPlugin[] => [
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
  withSetupMigrationTargetLock: vi.fn(
    async (_stateDir: string, run: () => Promise<unknown>) => await run(),
  ),
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

vi.mock("./onboard-interactive-runner.js", () => ({
  hasInteractiveOnboardingTty: mocks.hasInteractiveOnboardingTty,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: () => 18_789,
}));

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

vi.mock("../wizard/setup.migration-snapshot.js", () => ({
  withSetupMigrationTargetLock: mocks.withSetupMigrationTargetLock,
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

const localResetProviderCases = [
  { providerId: "ollama", methodId: "local" },
  { providerId: "lmstudio", methodId: "custom" },
] as const;

function mockLocalResetPreflight(params: {
  providerId: (typeof localResetProviderCases)[number]["providerId"];
  methodId: (typeof localResetProviderCases)[number]["methodId"];
  validationResult: boolean;
}) {
  const validateNonInteractive = vi.fn(
    async (ctx: ProviderAuthMethodNonInteractiveValidationContext) => {
      if (!params.validationResult) {
        ctx.runtime.error("Local provider preflight failed");
        ctx.runtime.exit(1);
      }
      return params.validationResult;
    },
  );
  const runNonInteractive = vi.fn(async () => ({}));

  mocks.resolvePluginProviders.mockReturnValueOnce([
    {
      id: params.providerId,
      label: params.providerId === "ollama" ? "Ollama" : "LM Studio",
      auth: [
        {
          id: params.methodId,
          label: "Local provider",
          kind: "custom",
          run: vi.fn(async () => ({ profiles: [] })),
          runNonInteractive,
          validateNonInteractive,
        },
      ],
    },
  ]);

  return { runNonInteractive, validateNonInteractive };
}

describe("setupWizardCommand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    mocks.hasInteractiveOnboardingTty.mockReturnValue(true);
    mocks.readConfigFileSnapshot.mockResolvedValue({ exists: false, valid: false, config: {} });
  });

  it.each(["main", "robby", "Robby!"])("accepts valid first-agent name %s", async (agentName) => {
    const runtime = makeRuntime();

    await setupWizardCommand({ nonInteractive: true, acceptRisk: true, agentName }, runtime);

    expect(mocks.runNonInteractiveSetup).toHaveBeenCalledWith(
      expect.objectContaining({ agentName }),
      runtime,
    );
  });

  it.each(["!!!", "openclaw", "crestodian"])(
    "rejects invalid or reserved first-agent name %s before setup",
    async (agentName) => {
      const runtime = makeRuntime();

      await setupWizardCommand(
        { nonInteractive: true, acceptRisk: true, reset: true, agentName },
        runtime,
      );

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Invalid --agent-name"));
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.handleReset).not.toHaveBeenCalled();
      expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
    },
  );

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

    await setupWizardCommand({ reset: true }, runtime);

    expectResetCall({ scope: "config+creds+sessions", runtime });
  });

  it.each([
    ["guided", { reset: true }],
    ["classic", { reset: true, classic: true }],
  ] as const)("rejects headless %s onboarding before reset", async (_label, options) => {
    const runtime = makeRuntime();
    mocks.hasInteractiveOnboardingTty.mockReturnValue(false);

    await setupWizardCommand(options, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runGuidedOnboarding).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it("keeps non-interactive reset ordering without a TTY", async () => {
    const runtime = makeRuntime();
    mocks.hasInteractiveOnboardingTty.mockReturnValue(false);

    await setupWizardCommand({ reset: true, nonInteractive: true, acceptRisk: true }, runtime);

    expect(mocks.withSetupMigrationTargetLock).toHaveBeenCalledOnce();
    expect(mocks.handleReset).toHaveBeenCalledOnce();
    expect(mocks.runNonInteractiveSetup).toHaveBeenCalledOnce();
    const lockOrder = mocks.withSetupMigrationTargetLock.mock.invocationCallOrder[0];
    const resetOrder = mocks.handleReset.mock.invocationCallOrder[0];
    const setupOrder = mocks.runNonInteractiveSetup.mock.invocationCallOrder[0];
    if (lockOrder === undefined || resetOrder === undefined || setupOrder === undefined) {
      throw new Error("expected lock, reset, and non-interactive setup calls");
    }
    expect(lockOrder).toBeLessThan(resetOrder);
    expect(resetOrder).toBeLessThan(setupOrder);
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

    await setupWizardCommand({ reset: true }, runtime);

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

    await setupWizardCommand({ reset: true, resetScope: "full" }, runtime);

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

    await setupWizardCommand({ reset: true, resetScope: "full" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Configured workspace is invalid. Pass --workspace with the workspace to remove, or use a narrower --reset-scope.",
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
  });

  it("requires an explicit workspace for a full reset when config is unreadable", async () => {
    const runtime = makeRuntime();
    // readConfigFileSnapshot always returns a sourceConfig object, so an
    // unreadable config is only recognizable through readError.
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      sourceConfig: {},
      readError: { code: "EACCES" },
    });

    await setupWizardCommand({ reset: true, resetScope: "full" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Cannot determine the configured workspace from an unreadable config. Pass --workspace with the workspace to remove, or use a narrower --reset-scope.",
    );
    expect(mocks.handleReset).not.toHaveBeenCalled();
  });

  it("uses the default workspace for a full reset when a readable config configures none", async () => {
    const runtime = makeRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      sourceConfig: { gateway: { port: 1 } },
    });

    await setupWizardCommand({ reset: true, resetScope: "full" }, runtime);

    expect(mocks.handleReset).toHaveBeenCalledWith(
      "full",
      resolveUserPath("~/.openclaw/workspace"),
      runtime,
    );
  });

  it("accepts explicit --reset-scope full", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand({ reset: true, resetScope: "full" }, runtime);

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

  it("rejects --reset-scope without --reset", async () => {
    const runtime = makeRuntime();

    await setupWizardCommand({ resetScope: "full" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--reset-scope requires --reset. Re-run with openclaw onboard --reset --reset-scope full.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runGuidedOnboarding).not.toHaveBeenCalled();
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
      label: "remote URL in local mode",
      options: { mode: "local" as const, remoteUrl: "wss://gateway.example.invalid" },
      expectedError: "--remote-url requires --mode remote in non-interactive setup.",
    },
    {
      label: "remote token in default local mode",
      options: { remoteToken: "fixture-token" },
      expectedError: "--remote-token requires --mode remote in non-interactive setup.",
    },
    {
      label: "remote password in default local mode",
      options: { remotePassword: "fixture-password" },
      expectedError: "--remote-password requires --mode remote in non-interactive setup.",
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

  const tokenError =
    "--gateway-token configures local gateway auth. Use --remote-token in remote mode.";
  const refError =
    "--gateway-token-ref-env configures local gateway auth. Use --remote-token with --secret-input-mode ref in remote mode.";
  it.each([
    [
      { remoteToken: "fixture-token", remotePassword: "fixture-password" },
      "Use either --remote-token or --remote-password, not both.",
    ],
    [{ remoteToken: " " }, "Invalid --remote-token: value cannot be empty."],
    [{ remotePassword: " " }, "Invalid --remote-password: value cannot be empty."],
    [
      { gatewayPassword: "fixture-password" },
      "--gateway-password configures local gateway auth. Use --remote-password in remote mode.",
    ],
    [{ gatewayToken: "fixture-token" }, tokenError],
    [{ gatewayTokenRefEnv: "MISSING_GATEWAY_TOKEN_ENV" }, refError],
    [{ nonInteractive: false, gatewayToken: "fixture-token" }, tokenError],
    [{ nonInteractive: false, gatewayTokenRefEnv: "MISSING_GATEWAY_TOKEN_ENV" }, refError],
  ] as const)("rejects invalid remote credentials %j before reset", async (options, message) => {
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        mode: "remote",
        remoteUrl: "wss://gateway.example.invalid",
        ...options,
      },
      runtime,
    );

    expect(runtime.error).toHaveBeenCalledWith(message);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.handleReset).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
  });

  it.each(
    (
      [
        ["gatewayPassword", "OPENCLAW_GATEWAY_PASSWORD"],
        ["remoteToken", "OPENCLAW_GATEWAY_TOKEN"],
        ["remotePassword", "OPENCLAW_GATEWAY_PASSWORD"],
      ] as const
    ).flatMap(([optionName, envName]) =>
      ["", "different-credential"].map((envValue) => ({ optionName, envName, envValue })),
    ),
  )(
    "rejects $optionName with env value $envValue before reading or resetting config",
    async ({ optionName, envName, envValue }) => {
      vi.stubEnv(envName, envValue);
      const runtime = makeRuntime();

      await setupWizardCommand(
        {
          reset: true,
          nonInteractive: true,
          acceptRisk: true,
          secretInputMode: "ref",
          [optionName]: "expected-credential",
          ...(optionName.startsWith("remote")
            ? { mode: "remote", remoteUrl: "wss://gateway.example.invalid" }
            : {}),
        },
        runtime,
      );

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(envName));
      if (envValue) {
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("does not match"));
      }
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mocks.handleReset).not.toHaveBeenCalled();
      expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
    },
  );

  it("keeps interactive gateway reference selection independent of the default env var", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        acceptRisk: true,
        gatewayPassword: "interactive-password",
        secretInputMode: "ref",
      },
      runtime,
    );

    expect(mocks.runInteractiveSetup).toHaveBeenCalledOnce();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

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

  it.each([
    { agentName: "robby", agentId: "robby", scope: "config", reuseProfile: true },
    { agentName: "Robby!", agentId: "robby", scope: "config", reuseProfile: true },
    { agentName: undefined, agentId: "main", scope: "config", reuseProfile: true },
    { agentName: "robby", agentId: "robby", scope: "config+creds+sessions", reuseProfile: false },
    { agentName: "robby", agentId: "robby", scope: "full", reuseProfile: false },
  ] as const)(
    "preflights $agentId provider profiles against reset scope $scope",
    async ({ agentName, agentId, scope, reuseProfile }) => {
      const runtime = makeRuntime();
      const workspaceDir = "/tmp/openclaw-reset-agent-workspace";
      const agentDirSuffix = path.join("agents", agentId, "agent");
      const resolveApiKey = vi
        .spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey")
        .mockImplementation(async (input) =>
          input.allowProfile && input.agentDir?.endsWith(agentDirSuffix)
            ? { key: "fixture-agent-profile-key", source: "profile" }
            : null,
        );

      try {
        await setupWizardCommand(
          {
            reset: true,
            resetScope: scope,
            nonInteractive: true,
            acceptRisk: true,
            agentName,
            workspace: workspaceDir,
            authChoice: "apiKey",
            tokenProvider: "anthropic",
          },
          runtime,
        );

        expect(resolveApiKey).toHaveBeenCalledWith(
          expect.objectContaining({
            agentDir: expect.stringContaining(agentDirSuffix),
            workspaceDir,
            allowProfile: reuseProfile,
          }),
        );
        expect(mocks.handleReset).toHaveBeenCalledTimes(reuseProfile ? 1 : 0);
        expect(mocks.runNonInteractiveSetup).toHaveBeenCalledTimes(reuseProfile ? 1 : 0);
      } finally {
        resolveApiKey.mockRestore();
      }
    },
  );

  it.each(localResetProviderCases)(
    "validates $providerId exactly once before reset and non-interactive setup",
    async ({ providerId, methodId }) => {
      const runtime = makeRuntime();
      const { runNonInteractive, validateNonInteractive } = mockLocalResetPreflight({
        providerId,
        methodId,
        validationResult: true,
      });

      await setupWizardCommand(
        {
          reset: true,
          nonInteractive: true,
          acceptRisk: true,
          authChoice: providerId,
        },
        runtime,
      );

      expect(validateNonInteractive).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          authChoice: providerId,
          config: {},
          baseConfig: {},
          opts: expect.objectContaining({ reset: true, nonInteractive: true }),
          runtime,
        }),
      );
      expect(mocks.handleReset).toHaveBeenCalledOnce();
      expect(mocks.runNonInteractiveSetup).toHaveBeenCalledOnce();
      expect(runNonInteractive).not.toHaveBeenCalled();

      const validationCall = validateNonInteractive.mock.invocationCallOrder.at(0);
      const resetCall = mocks.handleReset.mock.invocationCallOrder.at(0);
      const setupCall = mocks.runNonInteractiveSetup.mock.invocationCallOrder.at(0);
      if (validationCall === undefined || resetCall === undefined || setupCall === undefined) {
        throw new Error("Expected local provider validation, reset, and onboarding setup");
      }
      expect(validationCall).toBeLessThan(resetCall);
      expect(resetCall).toBeLessThan(setupCall);
    },
  );

  it.each(localResetProviderCases)(
    "never resets or starts setup when $providerId validation fails",
    async ({ providerId, methodId }) => {
      const runtime = makeRuntime();
      const { runNonInteractive, validateNonInteractive } = mockLocalResetPreflight({
        providerId,
        methodId,
        validationResult: false,
      });

      await setupWizardCommand(
        {
          reset: true,
          nonInteractive: true,
          acceptRisk: true,
          authChoice: providerId,
        },
        runtime,
      );

      expect(validateNonInteractive).toHaveBeenCalledOnce();
      expect(runtime.error).toHaveBeenCalledWith("Local provider preflight failed");
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.handleReset).not.toHaveBeenCalled();
      expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
      expect(runNonInteractive).not.toHaveBeenCalled();
    },
  );

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

  it("rejects ambiguous interactive provider flags before reset", async () => {
    const runtime = makeRuntime();
    await setupWizardCommand({ reset: true, nvidiaApiKey: "n", openaiApiKey: "o" }, runtime);
    expect(mocks.handleReset).not.toHaveBeenCalled();
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
      {
        skipChannels: false,
        skipSkills: false,
        acceptRisk: false,
        json: false,
        customImageInput: undefined,
      },
      runtime,
    );

    expect(mocks.runGuidedOnboarding).toHaveBeenCalledOnce();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
  });

  it.each([
    ["--agent-name", { agentName: "robby" }],
    ["--tui", { tui: true }],
    ["--skip-ui", { skipUi: true }],
    ["--suppress-gateway-token-output", { suppressGatewayTokenOutput: true }],
  ])("keeps %s on guided onboarding", async (_label, opts) => {
    const runtime = makeRuntime();

    await setupWizardCommand(opts, runtime);

    expect(mocks.runGuidedOnboarding).toHaveBeenCalledWith(opts, runtime);
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
    ["--custom-text-input", { customImageInput: false }],
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

  it.each([
    {
      opts: { classic: true },
      error:
        "--classic cannot be combined with --non-interactive. Remove --non-interactive to open the classic wizard, or remove --classic for automated setup.",
    },
    {
      opts: { tui: true },
      error:
        "--tui cannot be combined with --non-interactive. Remove --tui for automation, or remove --non-interactive to open the terminal hatch.",
    },
  ])("rejects conflicting $opts and non-interactive modes", async ({ opts, error }) => {
    const runtime = makeRuntime();
    await setupWizardCommand({ ...opts, nonInteractive: true, acceptRisk: true }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(error);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.runNonInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runInteractiveSetup).not.toHaveBeenCalled();
    expect(mocks.runGuidedOnboarding).not.toHaveBeenCalled();
  });
});
