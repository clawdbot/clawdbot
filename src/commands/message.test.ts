import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureEnv } from "../test-utils/env.js";

type RunMessageActionParams = {
  cfg?: unknown;
  action: string;
  params: Record<string, unknown>;
};

let testConfig: Record<string, unknown> = {};
const applyPluginAutoEnable = vi.hoisted(() => vi.fn(({ config }) => ({ config, changes: [] })));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => testConfig,
  loadConfig: () => testConfig,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

const resolveCommandConfigWithSecrets = vi.hoisted(() =>
  vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [] as string[],
  })),
);

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: async (opts: {
    autoEnable?: boolean;
    config: unknown;
    env?: NodeJS.ProcessEnv;
    runtime?: { log: (message: string) => void };
  }) => {
    const result = await resolveCommandConfigWithSecrets(opts);
    for (const entry of result.diagnostics ?? []) {
      opts.runtime?.log(`[secrets] ${entry}`);
    }
    const effectiveConfig =
      opts.autoEnable === true
        ? applyPluginAutoEnable({
            config: result.resolvedConfig,
            env: opts.env ?? process.env,
          }).config
        : result.effectiveConfig;
    return {
      ...result,
      effectiveConfig,
    };
  },
}));

const getScopedChannelsCommandSecretTargets = vi.hoisted(() =>
  vi.fn(() => ({
    targetIds: new Set(["channels.telegram.token"]),
  })),
);

vi.mock("../cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets,
}));

const runMessageActionMock = vi.hoisted(() =>
  vi.fn(async ({ action, params }: RunMessageActionParams) => ({
    kind: action === "poll" ? "poll" : "send",
    channel: typeof params.channel === "string" ? params.channel : "telegram",
    action: action === "poll" ? "poll" : "send",
    to: typeof params.target === "string" ? params.target : "123456",
    handledBy: "plugin",
    payload: { ok: true },
    dryRun: false,
  })),
);

vi.mock("../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: runMessageActionMock,
}));

let messageCommand: typeof import("./message.js").messageCommand;
let envSnapshot: ReturnType<typeof captureEnv>;

beforeAll(async () => {
  ({ messageCommand } = await import("./message.js"));
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

beforeEach(() => {
  envSnapshot = captureEnv(["TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.DISCORD_BOT_TOKEN = "";
  testConfig = {};
  runMessageActionMock.mockClear();
  resolveCommandConfigWithSecrets.mockClear();
  getScopedChannelsCommandSecretTargets.mockClear();
  applyPluginAutoEnable.mockClear();
  applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
  vi.mocked(runtime.log).mockClear();
  vi.mocked(runtime.error).mockClear();
  vi.mocked(runtime.exit).mockClear();
});

afterEach(() => {
  envSnapshot.restore();
});

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSlack: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
  ...overrides,
});

function createTelegramSecretRawConfig() {
  return {
    channels: {
      telegram: {
        token: { $secret: "vault://telegram/token" }, // pragma: allowlist secret
      },
    },
  };
}

function createTelegramResolvedTokenConfig(token: string) {
  return {
    channels: {
      telegram: {
        token,
      },
    },
  };
}

function mockResolvedCommandConfig(params: {
  rawConfig: Record<string, unknown>;
  resolvedConfig: Record<string, unknown>;
  diagnostics?: string[];
}) {
  testConfig = params.rawConfig;
  resolveCommandConfigWithSecrets.mockResolvedValueOnce({
    resolvedConfig: params.resolvedConfig,
    effectiveConfig: params.resolvedConfig,
    diagnostics: params.diagnostics ?? ["resolved channels.telegram.token"],
  });
}

async function runMessageCommand(opts: Record<string, unknown> = {}) {
  await messageCommand(
    {
      action: "send",
      channel: "telegram",
      target: "123456",
      message: "hi",
      json: true,
      ...opts,
    },
    makeDeps(),
    runtime,
  );
}

describe("messageCommand", () => {
  it("threads resolved SecretRef config into message actions", async () => {
    const rawConfig = createTelegramSecretRawConfig();
    const resolvedConfig = createTelegramResolvedTokenConfig("12345:resolved-token");
    mockResolvedCommandConfig({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
    });

    await runMessageCommand();

    expect(runMessageActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: resolvedConfig,
        action: "send",
        params: expect.objectContaining({
          channel: "telegram",
          target: "123456",
          message: "hi",
        }),
        agentId: "main",
        senderIsOwner: true,
        gateway: expect.objectContaining({
          clientName: "cli",
          mode: "cli",
        }),
      }),
    );
    expect(runMessageActionMock.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
    expect(resolveCommandConfigWithSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        config: rawConfig,
        commandName: "message",
      }),
    );
    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: rawConfig,
      channel: "telegram",
      accountId: undefined,
    });
    const call = resolveCommandConfigWithSecrets.mock.calls[0]?.[0] as {
      targetIds?: Set<string>;
    };
    expect(call.targetIds).toBeInstanceOf(Set);
    expect([...(call.targetIds ?? [])].every((id) => id.startsWith("channels.telegram."))).toBe(
      true,
    );
  });

  it("keeps local-fallback resolved cfg and logs diagnostics", async () => {
    const rawConfig = {
      channels: {
        telegram: {
          token: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
        },
      },
    };
    const locallyResolvedConfig = createTelegramResolvedTokenConfig("12345:local-fallback-token");
    mockResolvedCommandConfig({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: locallyResolvedConfig as unknown as Record<string, unknown>,
      diagnostics: ["gateway secrets.resolve unavailable; used local resolver fallback."],
    });

    await runMessageCommand();

    expect(runMessageActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: locallyResolvedConfig,
      }),
    );
    expect(runMessageActionMock.mock.calls[0]?.[0]?.cfg).not.toBe(rawConfig);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("[secrets] gateway secrets.resolve unavailable"),
    );
  });

  it("uses auto-enabled effective config for message actions", async () => {
    const rawConfig = {};
    const resolvedConfig = {};
    const autoEnabledConfig = {
      channels: {
        telegram: {
          token: "12345:auto-enabled-token",
        },
      },
      plugins: { allow: ["telegram"] },
    };
    mockResolvedCommandConfig({ rawConfig, resolvedConfig, diagnostics: [] });
    applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    await runMessageCommand({ channel: undefined });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: resolvedConfig,
      env: process.env,
    });
    expect(runMessageActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: autoEnabledConfig,
        params: expect.objectContaining({ target: "123456" }),
      }),
    );
  });

  it("normalizes poll actions and sender ownership before dispatch", async () => {
    await runMessageCommand({
      action: "poll",
      channel: "telegram",
      target: "123456789",
      pollQuestion: "Ship it?",
      pollOption: ["Yes", "No"],
      senderIsOwner: false,
    });

    expect(runMessageActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        senderIsOwner: false,
        params: expect.objectContaining({
          channel: "telegram",
          target: "123456789",
          pollQuestion: "Ship it?",
        }),
      }),
    );
  });

  it("rejects unknown message actions before dispatch", async () => {
    await expect(runMessageCommand({ action: "nope" })).rejects.toThrow("Unknown message action");
    expect(runMessageActionMock).not.toHaveBeenCalled();
  });
});
