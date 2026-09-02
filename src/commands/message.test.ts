// Message command tests cover CLI message sending, environment handling, and runtime dependency wiring.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureEnv } from "../test-utils/env.js";

type ResetPluginRuntimeStateForTest =
  typeof import("../plugins/runtime.js").resetPluginRuntimeStateForTest;
type SetActivePluginRegistry = typeof import("../plugins/runtime.js").setActivePluginRegistry;
type CreateTestRegistry = typeof import("../test-utils/channel-plugins.js").createTestRegistry;

let resetPluginRuntimeStateForTest: ResetPluginRuntimeStateForTest;
let setActivePluginRegistry: SetActivePluginRegistry;
let createTestRegistry: CreateTestRegistry;

type RunMessageActionParams = {
  cfg?: unknown;
  action: string;
  broadcastAccountPlan?: {
    accountId: string;
    candidateChannels: string[];
    secretChannels: string[];
  };
  params: Record<string, unknown>;
  agentId?: string;
  senderIsOwner?: boolean;
  conversationReadOrigin?: "delegated" | "direct-operator";
  gateway?: {
    clientName?: string;
    mode?: string;
  };
};

function readOnlyMessageActionCall(): RunMessageActionParams {
  expect(runMessageActionMock).toHaveBeenCalledOnce();
  const call = runMessageActionMock.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("Expected message action call");
  }
  return call;
}

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
  vi.fn(async ({ action, params }: RunMessageActionParams): Promise<MessageActionResult> => {
    const base = {
      channel: typeof params.channel === "string" ? params.channel : "telegram",
      to: typeof params.target === "string" ? params.target : "123456",
      handledBy: "plugin" as const,
      payload: { ok: true },
      dryRun: false,
    };
    return action === "poll"
      ? { ...base, kind: "poll", action: "poll" }
      : { ...base, kind: "send", action: "send" };
  }),
);

vi.mock("../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: runMessageActionMock,
}));

let messageCommand: typeof import("./message.js").messageCommand;
let envSnapshot: ReturnType<typeof captureEnv>;

beforeAll(async () => {
  ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("../plugins/runtime.js"));
  ({ createTestRegistry } = await import("../test-utils/channel-plugins.js"));
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
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
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
  resetPluginRuntimeStateForTest();
});

function createAccountPlugin(id: "slack" | "telegram", accountIds: string[]): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => accountIds,
      inspectAccount: () => ({ enabled: true }),
      resolveAccount: () => {
        throw new Error("raw account credentials must not resolve during planning");
      },
    },
  };
}

function createLegacySingleAccountPlugin(params: {
  id: "buzz";
  resolveAccount: ChannelPlugin["config"]["resolveAccount"];
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: `/channels/${params.id}`,
      blurb: "test",
    },
    capabilities: { chatTypes: ["group"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: params.resolveAccount,
    },
  };
}

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
  it("includes aggregate broadcast failure and every target row in JSON output", async () => {
    const results: Extract<MessageActionResult, { kind: "broadcast" }>["payload"]["results"] = [
      { channel: "telegram", to: "123", ok: true },
      { channel: "telegram", to: "456", ok: false, error: "provider rejected the message" },
    ];
    runMessageActionMock.mockResolvedValueOnce({
      kind: "broadcast",
      channel: "telegram",
      action: "broadcast",
      handledBy: "core",
      payload: { results },
      dryRun: false,
    });

    await runMessageCommand({
      action: "broadcast",
      target: undefined,
      targets: ["123", "456"],
    });

    const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
      ok?: boolean;
      payload?: { results?: unknown[] };
    };
    expect(output.ok).toBe(false);
    expect(output.payload?.results).toEqual(results);
  });

  it("rejects a malformed explicit account before resolving secrets", async () => {
    await expect(runMessageCommand({ accountId: "!!!" })).rejects.toThrow("Invalid account ID");

    expect(resolveCommandConfigWithSecrets).not.toHaveBeenCalled();
    expect(runMessageActionMock).not.toHaveBeenCalled();
  });

  it("scopes unqualified broadcast secrets to channels accepting the explicit account", async () => {
    const slackPlugin = createAccountPlugin("slack", ["shared"]);
    slackPlugin.config.isEnabled = vi.fn(() => {
      throw new Error("runtime enablement must not receive inspection metadata");
    });
    const telegramPlugin = createAccountPlugin("telegram", ["default"]);
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", source: "test", plugin: slackPlugin },
        { pluginId: "telegram", source: "test", plugin: telegramPlugin },
      ]),
    );
    testConfig = {
      channels: {
        slack: { accounts: { shared: { botToken: { $secret: "vault://slack/shared" } } } },
        telegram: {
          accounts: { default: { botToken: { $secret: "vault://telegram/default" } } },
        },
      },
    };

    await runMessageCommand({
      action: "broadcast",
      channel: "all",
      target: undefined,
      targets: ["slack:channel:ops", "telegram:123"],
      accountId: "shared",
    });

    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: testConfig,
      channel: undefined,
      channels: ["slack"],
      accountId: "shared",
    });
    expect(readOnlyMessageActionCall().broadcastAccountPlan).toEqual({
      accountId: "shared",
      candidateChannels: ["slack", "telegram"],
      secretChannels: ["slack"],
    });
    expect(slackPlugin.config.isEnabled).not.toHaveBeenCalled();
  });

  it("keeps unresolved SecretRefs for a legacy single-account broadcast plugin", async () => {
    const resolveAccount = vi.fn(() => ({
      accountId: "default",
      enabled: true,
      configured: false,
    }));
    const buzzPlugin = createLegacySingleAccountPlugin({ id: "buzz", resolveAccount });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "buzz", source: "test", plugin: buzzPlugin }]),
    );
    testConfig = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.test",
          privateKey: { source: "file", provider: "vault", id: "/buzz/private-key" },
        },
      },
    };

    await runMessageCommand({
      action: "broadcast",
      channel: "all",
      target: undefined,
      targets: ["00000000-0000-4000-8000-000000000001"],
      accountId: "default",
    });

    expect(resolveAccount).toHaveBeenCalledOnce();
    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: testConfig,
      channel: undefined,
      channels: ["buzz"],
      accountId: "default",
    });
    expect(readOnlyMessageActionCall().broadcastAccountPlan).toEqual({
      accountId: "default",
      candidateChannels: ["buzz"],
      secretChannels: ["buzz"],
    });
  });

  it("excludes unknown legacy-plugin accounts before account or secret resolution", async () => {
    const resolveAccount = vi.fn(() => ({ accountId: "default", enabled: true }));
    const buzzPlugin = createLegacySingleAccountPlugin({ id: "buzz", resolveAccount });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "buzz", source: "test", plugin: buzzPlugin }]),
    );
    testConfig = {
      channels: {
        buzz: {
          relayUrl: "wss://buzz.example.test",
          privateKey: { source: "file", provider: "vault", id: "/buzz/private-key" },
        },
      },
    };

    await runMessageCommand({
      action: "broadcast",
      channel: "all",
      target: undefined,
      targets: ["00000000-0000-4000-8000-000000000001"],
      accountId: "ops",
    });

    expect(resolveAccount).not.toHaveBeenCalled();
    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: testConfig,
      channel: undefined,
      channels: [],
      accountId: "ops",
    });
    expect(readOnlyMessageActionCall().broadcastAccountPlan).toEqual({
      accountId: "ops",
      candidateChannels: ["buzz"],
      secretChannels: [],
    });
  });

  it("threads resolved SecretRef config into message actions", async () => {
    const rawConfig = createTelegramSecretRawConfig();
    const resolvedConfig = createTelegramResolvedTokenConfig("12345:resolved-token");
    mockResolvedCommandConfig({
      rawConfig: rawConfig as unknown as Record<string, unknown>,
      resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
    });

    await runMessageCommand();

    const actionCall = readOnlyMessageActionCall();
    expect(actionCall.cfg).toBe(resolvedConfig);
    expect(actionCall.action).toBe("send");
    expect(actionCall.params.channel).toBe("telegram");
    expect(actionCall.params.target).toBe("123456");
    expect(actionCall.params.message).toBe("hi");
    expect(actionCall.agentId).toBe("main");
    expect(actionCall.senderIsOwner).toBe(true);
    expect(actionCall.conversationReadOrigin).toBe("direct-operator");
    expect(actionCall.gateway?.clientName).toBe("cli");
    expect(actionCall.gateway?.mode).toBe("cli");
    expect(actionCall.cfg).not.toBe(rawConfig);
    const configResolutionCall = resolveCommandConfigWithSecrets.mock.calls[0]?.[0] as {
      commandName?: string;
      config?: unknown;
      targetIds?: Set<string>;
    };
    expect(configResolutionCall.config).toBe(rawConfig);
    expect(configResolutionCall.commandName).toBe("message");
    expect(getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: rawConfig,
      channel: "telegram",
      accountId: undefined,
    });
    expect(configResolutionCall.targetIds).toBeInstanceOf(Set);
    expect(
      [...(configResolutionCall.targetIds ?? [])].filter(
        (id) => !id.startsWith("channels.telegram."),
      ),
    ).toStrictEqual([]);
  });

  it("keeps the retained legacy owner after config load strips the default marker", async () => {
    const migrated = migratePersistedImplicitMainRoster({
      agents: {
        entries: {
          ops: { default: true },
          research: {},
        },
      },
      channels: { telegram: {} },
    }).config as Record<string, unknown>;
    testConfig = migrated;
    const effectiveConfig = structuredClone(migrated);
    applyPluginAutoEnable.mockReturnValueOnce({ config: effectiveConfig, changes: [] });

    await runMessageCommand();

    expect(
      (migrated.agents as { entries?: { ops?: { default?: boolean } } }).entries?.ops?.default,
    ).toBeUndefined();
    expect(readOnlyMessageActionCall().cfg).toBe(effectiveConfig);
    expect(readOnlyMessageActionCall().agentId).toBe("ops");
  });

  it("resolves the ordinary owner from the effective command config", async () => {
    const effectiveConfig = { agents: { entries: { ops: {} } } };
    mockResolvedCommandConfig({ rawConfig: {}, resolvedConfig: effectiveConfig, diagnostics: [] });

    await runMessageCommand();

    expect(readOnlyMessageActionCall().cfg).toBe(effectiveConfig);
    expect(readOnlyMessageActionCall().agentId).toBe("ops");
  });

  it("uses the configured system owner for an explicit multi-agent config", async () => {
    const effectiveConfig = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };
    mockResolvedCommandConfig({ rawConfig: {}, resolvedConfig: effectiveConfig, diagnostics: [] });

    await runMessageCommand();

    expect(readOnlyMessageActionCall().cfg).toBe(effectiveConfig);
    expect(readOnlyMessageActionCall().agentId).toBe("ops");
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

    const actionCall = readOnlyMessageActionCall();
    expect(actionCall.cfg).toBe(locallyResolvedConfig);
    expect(actionCall.cfg).not.toBe(rawConfig);
    expect(
      vi
        .mocked(runtime.log)
        .mock.calls.some(([message]) =>
          String(message).includes("[secrets] gateway secrets.resolve unavailable"),
        ),
    ).toBe(true);
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
    const actionCall = readOnlyMessageActionCall();
    expect(actionCall.cfg).toBe(autoEnabledConfig);
    expect(actionCall.params.target).toBe("123456");
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

    const actionCall = readOnlyMessageActionCall();
    expect(actionCall.action).toBe("poll");
    expect(actionCall.senderIsOwner).toBe(false);
    expect(actionCall.params.channel).toBe("telegram");
    expect(actionCall.params.target).toBe("123456789");
    expect(actionCall.params.pollQuestion).toBe("Ship it?");
  });

  it.each([
    {
      name: "nested",
      payload: {
        ok: true,
        result: {
          messageId: "msg-json-1",
          channelId: "general",
        },
      },
      expectedMessageId: "msg-json-1",
      expectedPayload: {
        ok: true,
        result: {
          messageId: "msg-json-1",
          channelId: "general",
        },
      },
    },
    {
      name: "direct-before-nested",
      payload: {
        messageId: " direct-id ",
        result: { messageId: "nested-id" },
      },
      expectedMessageId: "direct-id",
      expectedPayload: {
        messageId: " direct-id ",
        result: { messageId: "nested-id" },
      },
    },
    {
      name: "array object",
      payload: Object.assign([], { messageId: " array-id " }),
      expectedMessageId: "array-id",
      expectedPayload: [],
    },
  ])("includes a stable top-level messageId from a $name payload", async (testCase) => {
    runMessageActionMock.mockResolvedValueOnce({
      kind: "send",
      channel: "discord",
      action: "send",
      to: "channel:general",
      handledBy: "plugin",
      payload: testCase.payload,
      dryRun: false,
    });

    await runMessageCommand({
      channel: "discord",
      target: "channel:general",
    });

    const output = vi.mocked(runtime.log).mock.calls[0]?.[0];
    const json = JSON.parse(String(output)) as { messageId?: string; payload?: unknown };
    expect(json.messageId).toBe(testCase.expectedMessageId);
    expect(json.payload).toEqual(testCase.expectedPayload);
    expect(json).not.toHaveProperty("ok");
  });

  it.each([
    {
      status: "suppressed" as const,
      suppressionReason: "cancelled_by_message_sending_hook" as const,
      expected: "Message send suppressed: cancelled_by_message_sending_hook.",
    },
    {
      status: "failed" as const,
      error: "provider rejected the message",
      expected: "provider rejected the message",
    },
    {
      status: "partial_failed" as const,
      error: "second attachment rejected",
      messageId: "first-part-1",
      expected: "second attachment rejected",
    },
  ])(
    "reports $status sends truthfully in JSON output",
    async ({ status, suppressionReason, error, messageId, expected }) => {
      const sendResult = {
        channel: "discord",
        to: "channel:general",
        via: "direct" as const,
        mediaUrl: null,
        deliveryStatus: status,
        ...(suppressionReason ? { suppressionReason } : {}),
        ...(error ? { error } : {}),
        ...(messageId ? { result: { channel: "discord", messageId } } : {}),
        ...(status === "partial_failed" ? { sentBeforeError: true as const } : {}),
      };
      runMessageActionMock.mockResolvedValueOnce({
        kind: "send",
        channel: "discord",
        action: "send",
        to: "channel:general",
        handledBy: "core",
        payload: sendResult,
        sendResult,
        dryRun: false,
      });

      await runMessageCommand({ channel: "discord", target: "channel:general" });

      const json = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
      expect(json).toMatchObject({
        ok: false,
        deliveryStatus: status,
        error: { type: "cli_error", message: expected },
      });
      expect(json.payload).toEqual(sendResult);
      if (messageId) {
        expect(json.messageId).toBe(messageId);
        expect(json.sentBeforeError).toBe(true);
      }
    },
  );

  it.each([
    [
      "disabled reaction",
      "react",
      { ok: false, hint: "Reactions are disabled." },
      "Reactions are disabled.",
    ],
    [
      "rejected added reaction",
      "react",
      { ok: false, warning: "Unavailable", added: "✅" },
      "Unavailable",
    ],
    [
      "rejected delete",
      "delete",
      { ok: false, deleted: false, warning: "Not deleted" },
      "Not deleted",
    ],
    ["rejected poll", "poll", { ok: false, error: "Poll rejected" }, "Poll rejected"],
    ["rejected send", "send", { ok: false, error: "Message rejected" }, "Message rejected"],
  ] as const)("reports %s truthfully in JSON output", async (_name, action, payload, expected) => {
    runMessageActionMock.mockResolvedValueOnce({
      kind: action === "send" || action === "poll" ? action : "action",
      channel: "telegram",
      action,
      to: "123456",
      handledBy: "plugin",
      payload,
      dryRun: false,
    } as MessageActionResult);

    await runMessageCommand({ action });

    const json = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]));
    expect(json).toMatchObject({
      ok: false,
      error: { type: "cli_error", message: expected },
    });
    expect(json.payload).toEqual(payload);
    expect(json).not.toHaveProperty("deliveryStatus");
  });

  it("rejects unknown message actions before dispatch", async () => {
    await expect(runMessageCommand({ action: "nope" })).rejects.toThrow("Unknown message action");
    expect(runMessageActionMock).not.toHaveBeenCalled();
  });
});
