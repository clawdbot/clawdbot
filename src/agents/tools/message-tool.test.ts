import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName, ChannelPlugin } from "../../channels/plugins/types.js";
import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
type CreateMessageTool = typeof import("./message-tool.js").createMessageTool;
type CreateOpenClawTools = typeof import("../openclaw-tools.js").createOpenClawTools;
type ResetPluginRuntimeStateForTest =
  typeof import("../../plugins/runtime.js").resetPluginRuntimeStateForTest;
type SetActivePluginRegistry = typeof import("../../plugins/runtime.js").setActivePluginRegistry;
type CreateTestRegistry = typeof import("../../test-utils/channel-plugins.js").createTestRegistry;

let createMessageTool: CreateMessageTool;
let createOpenClawTools: CreateOpenClawTools;
let resetPluginRuntimeStateForTest: ResetPluginRuntimeStateForTest;
let setActivePluginRegistry: SetActivePluginRegistry;
let createTestRegistry: CreateTestRegistry;

type DescribeMessageTool = NonNullable<
  NonNullable<ChannelPlugin["actions"]>["describeMessageTool"]
>;
type MessageToolDiscoveryContext = Parameters<DescribeMessageTool>[0];
type MessageToolSchema = NonNullable<ReturnType<DescribeMessageTool>>["schema"];

function createTelegramPollExtraToolSchemas() {
  return {
    pollDurationSeconds: Type.Optional(Type.Number()),
    pollAnonymous: Type.Optional(Type.Boolean()),
    pollPublic: Type.Optional(Type.Boolean()),
  };
}

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  })),
  getScopedChannelsCommandSecretTargets: vi.fn(
    ({
      config,
      channel,
      accountId,
    }: {
      config?: { channels?: Record<string, unknown> };
      channel?: string | null;
      accountId?: string | null;
    }) => {
      const allowedPaths = new Set<string>();
      const targetIds = new Set<string>();
      const scopedChannel = channel?.trim();
      const scopedAccountId = accountId?.trim();
      const scopedConfig =
        scopedChannel && config?.channels && typeof config.channels[scopedChannel] === "object"
          ? (config.channels[scopedChannel] as Record<string, unknown>)
          : null;
      if (!scopedChannel || !scopedConfig) {
        return { targetIds };
      }

      const maybeCollectSecretPath = (path: string, value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return;
        }
        const record = value as Record<string, unknown>;
        if (typeof record.source === "string" && typeof record.id === "string") {
          targetIds.add(path);
          allowedPaths.add(path);
        }
      };

      maybeCollectSecretPath(`channels.${scopedChannel}.token`, scopedConfig.token);
      maybeCollectSecretPath(`channels.${scopedChannel}.botToken`, scopedConfig.botToken);
      if (scopedAccountId) {
        const accountRecord =
          scopedConfig.accounts &&
          typeof scopedConfig.accounts === "object" &&
          !Array.isArray(scopedConfig.accounts) &&
          typeof (scopedConfig.accounts as Record<string, unknown>)[scopedAccountId] === "object"
            ? ((scopedConfig.accounts as Record<string, unknown>)[scopedAccountId] as Record<
                string,
                unknown
              >)
            : null;
        if (accountRecord) {
          maybeCollectSecretPath(
            `channels.${scopedChannel}.accounts.${scopedAccountId}.token`,
            accountRecord.token,
          );
          maybeCollectSecretPath(
            `channels.${scopedChannel}.accounts.${scopedAccountId}.botToken`,
            accountRecord.botToken,
          );
        }
      }

      return {
        targetIds,
        ...(allowedPaths.size > 0 ? { allowedPaths } : {}),
      };
    },
  ),
}));

type RunMessageActionInput = {
  agentId?: string;
  cfg?: unknown;
  params?: Record<string, unknown>;
  requesterSenderId?: string;
  sandboxRoot?: string;
  senderIsOwner?: boolean;
  sessionKey?: string;
  toolContext?: {
    currentThreadTs?: string;
    replyToMode?: string;
  };
};

function firstRunMessageActionInput(): RunMessageActionInput | undefined {
  return mocks.runMessageAction.mock.calls[0]?.[0] as RunMessageActionInput | undefined;
}

function latestSecretResolveCall(): {
  allowedPaths?: Set<string>;
  config?: unknown;
  targetIds?: Set<string>;
} {
  const calls = mocks.resolveCommandSecretRefsViaGateway.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected secret resolution call");
  }
  return call[0] as {
    allowedPaths?: Set<string>;
    config?: unknown;
    targetIds?: Set<string>;
  };
}

const openClawToolsFactoryMocks = vi.hoisted(() => {
  const tool = (name: string) => ({
    name,
    displaySummary: `${name} test stub`,
    description: `${name} test stub`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ type: "json", data: { ok: true } })),
  });
  return {
    tool,
  };
});

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return {
    ...actual,
    runMessageAction: mocks.runMessageAction,
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.getRuntimeConfig,
  };
});

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: mocks.getScopedChannelsCommandSecretTargets,
}));

vi.mock("../../channels/plugins/message-tool-api.js", () => ({
  resolveBundledChannelMessageToolDiscoveryAdapter: () => ({
    describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
  }),
}));

vi.mock("./agents-list-tool.js", () => ({
  createAgentsListTool: () => openClawToolsFactoryMocks.tool("agents"),
}));
vi.mock("./cron-tool.js", () => ({
  createCronTool: () => openClawToolsFactoryMocks.tool("cron"),
}));
vi.mock("./gateway-tool.js", () => ({
  createGatewayTool: () => openClawToolsFactoryMocks.tool("gateway"),
}));
vi.mock("./heartbeat-response-tool.js", () => ({
  createHeartbeatResponseTool: () => openClawToolsFactoryMocks.tool("heartbeat_response"),
}));
vi.mock("./image-generate-tool.js", () => ({
  createImageGenerateTool: () => null,
}));
vi.mock("./image-tool.js", () => ({
  createImageTool: () => null,
}));
vi.mock("./manifest-capability-availability.js", () => ({
  hasSnapshotCapabilityAvailability: () => false,
  hasSnapshotProviderEnvAvailability: () => false,
  loadCapabilityMetadataSnapshot: () => ({ index: {}, plugins: [] }),
}));
vi.mock("./music-generate-tool.js", () => ({
  createMusicGenerateTool: () => null,
}));
vi.mock("./nodes-tool.js", () => ({
  createNodesTool: () => openClawToolsFactoryMocks.tool("nodes"),
}));
vi.mock("./pdf-tool.js", () => ({
  createPdfTool: () => null,
}));
vi.mock("./session-status-tool.js", () => ({
  createSessionStatusTool: () => openClawToolsFactoryMocks.tool("session_status"),
}));
vi.mock("./sessions-history-tool.js", () => ({
  createSessionsHistoryTool: () => openClawToolsFactoryMocks.tool("sessions_history"),
}));
vi.mock("./sessions-list-tool.js", () => ({
  createSessionsListTool: () => openClawToolsFactoryMocks.tool("sessions_list"),
}));
vi.mock("./sessions-send-tool.js", () => ({
  createSessionsSendTool: () => openClawToolsFactoryMocks.tool("sessions_send"),
}));
vi.mock("./sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: () => openClawToolsFactoryMocks.tool("sessions_spawn"),
}));
vi.mock("./sessions-yield-tool.js", () => ({
  createSessionsYieldTool: () => openClawToolsFactoryMocks.tool("sessions_yield"),
}));
vi.mock("./subagents-tool.js", () => ({
  createSubagentsTool: () => openClawToolsFactoryMocks.tool("subagents"),
}));
vi.mock("./tts-tool.js", () => ({
  createTtsTool: () => openClawToolsFactoryMocks.tool("tts"),
}));
vi.mock("./update-plan-tool.js", () => ({
  createUpdatePlanTool: () => openClawToolsFactoryMocks.tool("update_plan"),
}));
vi.mock("./video-generate-tool.js", () => ({
  createVideoGenerateTool: () => null,
}));
vi.mock("./web-tools.js", () => ({
  createWebFetchTool: () => openClawToolsFactoryMocks.tool("web_fetch"),
  createWebSearchTool: () => openClawToolsFactoryMocks.tool("web_search"),
}));

function mockSendResult(overrides: { channel?: string; to?: string } = {}) {
  mocks.runMessageAction.mockClear();
  mocks.runMessageAction.mockResolvedValue({
    kind: "send",
    action: "send",
    channel: overrides.channel ?? "telegram",
    to: overrides.to ?? "telegram:123",
    handledBy: "plugin",
    payload: {},
    dryRun: true,
  } satisfies MessageActionRunResult);
}

function getToolProperties(tool: ReturnType<CreateMessageTool>) {
  return (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
}

function getActionEnum(properties: Record<string, unknown>) {
  return (properties.action as { enum?: string[] } | undefined)?.enum ?? [];
}

function expectStringSchema(
  schema: unknown,
  expected?: {
    description?: string;
  },
) {
  if (!schema || typeof schema !== "object") {
    throw new Error("Expected string schema");
  }
  const record = schema as Record<string, unknown>;
  expect(record.type).toBe("string");
  if (expected?.description) {
    expect(record.description).toBe(expected.description);
  }
}

beforeAll(async () => {
  ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await import("../../plugins/runtime.js"));
  ({ createTestRegistry } = await import("../../test-utils/channel-plugins.js"));
  ({ createMessageTool } = await import("./message-tool.js"));
  ({ createOpenClawTools } = await import("../openclaw-tools.js"));
});

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  mocks.runMessageAction.mockReset();
  mocks.getRuntimeConfig.mockReset().mockReturnValue({});
  mocks.resolveCommandSecretRefsViaGateway.mockReset().mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
  }));
  mocks.getScopedChannelsCommandSecretTargets.mockClear();
  setActivePluginRegistry(createTestRegistry([]));
});

function createChannelPlugin(params: {
  id: string;
  label: string;
  docsPath: string;
  blurb: string;
  aliases?: string[];
  actions?: ChannelMessageActionName[];
  capabilities?: readonly ChannelMessageCapability[];
  toolSchema?: MessageToolSchema | ((params: MessageToolDiscoveryContext) => MessageToolSchema);
  describeMessageTool?: DescribeMessageTool;
  messaging?: ChannelPlugin["messaging"];
}): ChannelPlugin {
  return {
    id: params.id as ChannelPlugin["id"],
    meta: {
      id: params.id as ChannelPlugin["id"],
      label: params.label,
      selectionLabel: params.label,
      docsPath: params.docsPath,
      blurb: params.blurb,
      aliases: params.aliases,
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    ...(params.messaging ? { messaging: params.messaging } : {}),
    actions: {
      describeMessageTool:
        params.describeMessageTool ??
        ((ctx) => {
          const schema =
            typeof params.toolSchema === "function" ? params.toolSchema(ctx) : params.toolSchema;
          return {
            actions: params.actions ?? [],
            capabilities: params.capabilities,
            ...(schema ? { schema } : {}),
          };
        }),
    },
  };
}

async function executeSend(params: {
  action: Record<string, unknown>;
  toolOptions?: Partial<Parameters<typeof createMessageTool>[0]>;
}) {
  const tool = createMessageTool({
    config: {} as never,
    runMessageAction: mocks.runMessageAction as never,
    ...params.toolOptions,
  });
  await tool.execute("1", {
    action: "send",
    ...params.action,
  });
  return firstRunMessageActionInput();
}

describe("message tool secret scoping", () => {
  it("marks message-tool-only source replies in the tool description", () => {
    const scopedTool = createMessageTool({
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const explicitTargetTool = createMessageTool({
      requireExplicitTarget: true,
      sourceReplyDeliveryMode: "message_tool_only",
    });
    const defaultTool = createMessageTool();

    expect(scopedTool.description).toContain(
      'visible replies to the current source conversation must use action="send"',
    );
    expect(scopedTool.description).toContain("target defaults to the current source conversation");
    expect(scopedTool.description).toContain("Normal final answers are private");
    expect(explicitTargetTool.description).toContain("Include target when sending");
    expect(explicitTargetTool.description).not.toContain(
      "target defaults to the current source conversation",
    );
    expect(defaultTool.description).not.toContain(
      "visible replies to the current source conversation",
    );
  });

  it("forwards source reply delivery mode through createOpenClawTools", () => {
    const tool = createOpenClawTools({
      config: {} as never,
      sourceReplyDeliveryMode: "message_tool_only",
    }).find((candidate) => candidate.name === "message");

    expect(tool?.description).toContain(
      'visible replies to the current source conversation must use action="send"',
    );
  });

  it("scopes command-time secret resolution to the selected channel/account", async () => {
    mockSendResult({ channel: "discord", to: "discord:123" });
    mocks.getRuntimeConfig.mockReturnValue({
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_TOKEN" },
          accounts: {
            ops: { token: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" } },
            chat: { token: { source: "env", provider: "default", id: "DISCORD_CHAT_TOKEN" } },
          },
        },
        slack: {
          botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        },
      },
    });

    const tool = createMessageTool({
      currentChannelProvider: "discord",
      agentAccountId: "ops",
      getRuntimeConfig: mocks.getRuntimeConfig as never,
      getScopedChannelsCommandSecretTargets: mocks.getScopedChannelsCommandSecretTargets as never,
      resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway as never,
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "channel:123",
      message: "hi",
    });

    const secretResolveCall = latestSecretResolveCall();
    expect(secretResolveCall.targetIds).toBeInstanceOf(Set);
    expect(
      [...(secretResolveCall.targetIds ?? [])].every((id) => id.startsWith("channels.discord.")),
    ).toBe(true);
    expect(secretResolveCall.allowedPaths).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.ops.token"]),
    );
  });

  it("resolves scoped channel SecretRefs even when constructed with a config snapshot", async () => {
    mockSendResult({ channel: "discord", to: "channel:123" });
    const rawConfig = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          accounts: {
            ops: { token: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" } },
          },
        },
      },
    };
    const resolvedConfig = {
      channels: {
        discord: {
          token: "resolved-discord-token",
          accounts: {
            ops: { token: "resolved-discord-ops-token" },
          },
        },
      },
    };
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValueOnce({
      resolvedConfig,
      diagnostics: [],
    });

    const tool = createMessageTool({
      config: rawConfig as never,
      currentChannelProvider: "discord",
      currentChannelId: "channel:123",
      agentAccountId: "ops",
      resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway as never,
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "send",
      message: "hi",
    });

    const secretResolveCall = latestSecretResolveCall();
    expect(secretResolveCall.config).toBe(rawConfig);
    expect(secretResolveCall.targetIds).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.ops.token"]),
    );
    expect(secretResolveCall.allowedPaths).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.ops.token"]),
    );
    expect(firstRunMessageActionInput()?.cfg).toBe(resolvedConfig);
  });
});

describe("message tool agent routing", () => {
  it("derives agentId from the session key", async () => {
    mockSendResult();

    const tool = createMessageTool({
      agentSessionKey: "agent:alpha:main",
      config: {} as never,
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "send",
      target: "telegram:123",
      message: "hi",
    });

    const call = firstRunMessageActionInput();
    expect(call?.agentId).toBe("alpha");
    expect(call?.sessionKey).toBe("agent:alpha:main");
  });

  it("uses agentThreadId as ambient thread context when currentThreadTs is absent", async () => {
    mockSendResult({ channel: "slack", to: "channel:C123" });

    const tool = createMessageTool({
      agentSessionKey: "agent:main:slack:channel:c123:thread:111.222",
      config: {} as never,
      currentChannelProvider: "slack",
      currentChannelId: "channel:C123",
      agentThreadId: "111.222",
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "send",
      channel: "slack",
      message: "stay in thread",
    });

    const call = firstRunMessageActionInput();
    expect(call?.toolContext?.currentThreadTs).toBe("111.222");
    expect(call?.toolContext?.replyToMode).toBe("all");
  });

  it("keeps explicit reply mode opt-out when agentThreadId is present", async () => {
    mockSendResult({ channel: "slack", to: "channel:C123" });

    const tool = createMessageTool({
      agentSessionKey: "agent:main:slack:channel:c123:thread:111.222",
      config: {} as never,
      currentChannelProvider: "slack",
      currentChannelId: "channel:C123",
      agentThreadId: "111.222",
      replyToMode: "off",
      runMessageAction: mocks.runMessageAction as never,
    });

    await tool.execute("1", {
      action: "send",
      channel: "slack",
      message: "send at channel level",
    });

    const call = firstRunMessageActionInput();
    expect(call?.toolContext?.currentThreadTs).toBe("111.222");
    expect(call?.toolContext?.replyToMode).toBe("off");
  });

  it("forwards agentThreadId through createOpenClawTools to the message tool", async () => {
    mockSendResult({ channel: "slack", to: "channel:C123" });

    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:slack:channel:c123:thread:111.222",
      config: {} as never,
      agentChannel: "slack",
      currentChannelId: "channel:C123",
      agentThreadId: "111.222",
    }).find((candidate) => candidate.name === "message");

    if (!tool) {
      throw new Error("message tool not found");
    }

    await tool.execute("1", {
      action: "send",
      channel: "slack",
      message: "stay in thread",
    });

    const call = firstRunMessageActionInput();
    expect(call?.toolContext?.currentThreadTs).toBe("111.222");
    expect(call?.toolContext?.replyToMode).toBe("all");
  });
});

describe("message tool explicit target guard", () => {
  it("requires an explicit target for upload-file when configured", async () => {
    const tool = createMessageTool({
      runMessageAction: mocks.runMessageAction as never,
      requireExplicitTarget: true,
      currentChannelProvider: "slack",
      currentChannelId: "channel:C123",
    });

    await expect(
      tool.execute("1", {
        action: "upload-file",
        filePath: "/tmp/report.png",
      }),
    ).rejects.toThrow(/Explicit message target required/i);

    expect(mocks.runMessageAction).not.toHaveBeenCalled();
  });

  it("allows upload-file when an explicit target is provided", async () => {
    mocks.runMessageAction.mockResolvedValueOnce({
      kind: "action",
      channel: "slack",
      action: "upload-file",
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel: "slack", action: "upload-file" },
      dryRun: true,
    });

    const tool = createMessageTool({
      runMessageAction: mocks.runMessageAction as never,
      requireExplicitTarget: true,
      currentChannelProvider: "slack",
      currentChannelId: "channel:C123",
    });

    await tool.execute("1", {
      action: "upload-file",
      target: "channel:C999",
      filePath: "/tmp/report.png",
    });

    const call = firstRunMessageActionInput();
    expect(call?.params?.target).toBe("channel:C999");
  });
});

describe("message tool path passthrough", () => {
  it.each([
    { field: "path", value: "~/Downloads/voice.ogg" },
    { field: "filePath", value: "./tmp/note.m4a" },
  ])("does not convert $field to media for send", async ({ field, value }) => {
    mockSendResult({ to: "telegram:123" });

    const call = await executeSend({
      action: {
        target: "telegram:123",
        [field]: value,
        message: "",
      },
    });

    expect(call?.params?.[field]).toBe(value);
    expect(call?.params?.media).toBeUndefined();
  });
});

describe("message tool Telegram topic targets", () => {
  it("passes numeric forum topic targets and thread ids to outbound resolution", async () => {
    mockSendResult({ to: "telegram:-1001234567890:topic:42" });

    const call = await executeSend({
      toolOptions: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:-1001234567890:topic:42",
      },
      action: {
        channel: "telegram",
        target: "-1001234567890:topic:42",
        threadId: "42",
        message: "topic hello",
      },
    });

    expect(call?.params?.channel).toBe("telegram");
    expect(call?.params?.target).toBe("-1001234567890:topic:42");
    expect(call?.params?.threadId).toBe("42");
    expect(call?.params?.message).toBe("topic hello");
  });
});

describe("message tool schema scoping", () => {
  const telegramPlugin = createChannelPlugin({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    blurb: "Telegram test plugin.",
    actions: ["send", "react", "poll"],
    capabilities: ["presentation"],
    toolSchema: () => [
      {
        properties: createTelegramPollExtraToolSchemas(),
        visibility: "all-configured",
      },
    ],
  });

  const discordPlugin = createChannelPlugin({
    id: "discord",
    label: "Discord",
    docsPath: "/channels/discord",
    blurb: "Discord test plugin.",
    actions: ["send", "poll", "poll-vote"],
    capabilities: ["presentation"],
  });

  const slackPlugin = createChannelPlugin({
    id: "slack",
    label: "Slack",
    docsPath: "/channels/slack",
    blurb: "Slack test plugin.",
    actions: ["send", "react"],
    capabilities: ["presentation"],
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it.each([
    {
      provider: "telegram",
      expectTelegramPollExtras: true,
      expectedActions: ["send", "react", "poll", "poll-vote"],
    },
    {
      provider: "discord",
      expectTelegramPollExtras: true,
      expectedActions: ["send", "poll", "poll-vote", "react"],
    },
    {
      provider: "slack",
      expectTelegramPollExtras: true,
      expectedActions: ["send", "react", "poll", "poll-vote"],
    },
  ])(
    "scopes schema fields for $provider",
    ({ provider, expectTelegramPollExtras, expectedActions }) => {
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "telegram", source: "test", plugin: telegramPlugin },
          { pluginId: "discord", source: "test", plugin: discordPlugin },
          { pluginId: "slack", source: "test", plugin: slackPlugin },
        ]),
      );

      const tool = createMessageTool({
        config: {} as never,
        currentChannelProvider: provider,
      });
      const properties = getToolProperties(tool);
      const actionEnum = getActionEnum(properties);

      expect(properties).toHaveProperty("presentation");
      expect(properties.components).toBeUndefined();
      expect(properties.blocks).toBeUndefined();
      expect(properties.buttons).toBeUndefined();
      for (const action of expectedActions) {
        expect(actionEnum).toContain(action);
      }
      if (expectTelegramPollExtras) {
        expect(properties).toHaveProperty("pollDurationSeconds");
        expect(properties).toHaveProperty("pollAnonymous");
        expect(properties).toHaveProperty("pollPublic");
      } else {
        expect(properties.pollDurationSeconds).toBeUndefined();
        expect(properties.pollAnonymous).toBeUndefined();
        expect(properties.pollPublic).toBeUndefined();
      }
      expect(properties).toHaveProperty("pollId");
      expect(properties).toHaveProperty("pollOptionIndex");
      expect(properties).toHaveProperty("pollOptionId");
    },
  );

  it("includes poll in the action enum when the current channel supports poll actions", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });
    const actionEnum = getActionEnum(getToolProperties(tool));

    expect(actionEnum).toContain("poll");
  });

  it("hides telegram poll extras when telegram polls are disabled in scoped mode", () => {
    const telegramPluginWithConfig = createChannelPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram test plugin.",
      describeMessageTool: ({ cfg }) => {
        const telegramCfg = (cfg as { channels?: { telegram?: { actions?: { poll?: boolean } } } })
          .channels?.telegram;
        return {
          actions:
            telegramCfg?.actions?.poll === false ? ["send", "react"] : ["send", "react", "poll"],
          capabilities: ["presentation"],
          schema:
            telegramCfg?.actions?.poll === false
              ? []
              : [
                  {
                    properties: createTelegramPollExtraToolSchemas(),
                    visibility: "all-configured" as const,
                  },
                ],
        };
      },
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", source: "test", plugin: telegramPluginWithConfig },
      ]),
    );

    const tool = createMessageTool({
      config: {
        channels: {
          telegram: {
            actions: {
              poll: false,
            },
          },
        },
      } as never,
      currentChannelProvider: "telegram",
    });
    const properties = getToolProperties(tool);
    const actionEnum = getActionEnum(properties);

    expect(actionEnum).not.toContain("poll");
    expect(properties.pollDurationSeconds).toBeUndefined();
    expect(properties.pollAnonymous).toBeUndefined();
    expect(properties.pollPublic).toBeUndefined();
  });

  it("uses discovery account scope for capability-gated presentation", () => {
    const scopedInteractivePlugin = createChannelPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram test plugin.",
      describeMessageTool: ({ accountId }) => ({
        actions: ["send"],
        capabilities: accountId === "ops" ? ["presentation"] : [],
      }),
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "telegram", source: "test", plugin: scopedInteractivePlugin },
      ]),
    );

    const scopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
      agentAccountId: "ops",
    });
    const unscopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });

    expect(getToolProperties(scopedTool)).toHaveProperty("presentation");
    expect(getToolProperties(unscopedTool).presentation).toBeUndefined();
  });

  it("keeps send-only scoped schemas small", () => {
    const sendOnlyPlugin = createChannelPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram send plugin.",
      actions: ["send"],
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: sendOnlyPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "telegram",
    });
    const properties = getToolProperties(tool);

    expect(getActionEnum(properties)).toEqual(["send"]);
    expect(properties).toHaveProperty("message");
    expect(properties).toHaveProperty("target");
    expect(properties).toHaveProperty("media");
    expect(properties).not.toHaveProperty("pollId");
    expect(properties).not.toHaveProperty("messageId");
    expect(properties).not.toHaveProperty("channelId");
    expect(properties).not.toHaveProperty("activityName");
    expect(properties).not.toHaveProperty("eventName");
  });

  it("filters scoped schemas through the per-agent message action allowlist", () => {
    const plugin = createChannelPlugin({
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
      blurb: "Discord test plugin.",
      actions: ["send", "read", "react", "delete"],
    });

    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));

    const tool = createMessageTool({
      config: {
        agents: {
          list: [
            {
              id: "sandbox",
              tools: {
                message: {
                  actions: {
                    allow: ["send"],
                  },
                },
              },
            },
          ],
        },
      } as never,
      currentChannelProvider: "discord",
      agentId: "sandbox",
    });
    const properties = getToolProperties(tool);

    expect(getActionEnum(properties)).toEqual(["send"]);
    expect(properties).toHaveProperty("message");
    expect(properties).toHaveProperty("target");
    expect(properties).not.toHaveProperty("messageId");
    expect(tool.description).toContain("Supports actions: send.");
    expect(tool.description).not.toContain("react");
  });

  it("uses discovery account scope for other configured channel actions", () => {
    const currentPlugin = createChannelPlugin({
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
      blurb: "Discord test plugin.",
      actions: ["send"],
    });
    const scopedOtherPlugin = createChannelPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram test plugin.",
      describeMessageTool: ({ accountId }) => ({
        actions: accountId === "ops" ? ["react"] : [],
      }),
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "discord", source: "test", plugin: currentPlugin },
        { pluginId: "telegram", source: "test", plugin: scopedOtherPlugin },
      ]),
    );

    const scopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "discord",
      agentAccountId: "ops",
    });
    const unscopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "discord",
    });

    expect(getActionEnum(getToolProperties(scopedTool))).toContain("react");
    expect(getActionEnum(getToolProperties(unscopedTool))).not.toContain("react");
    expect(scopedTool.description).toContain("Supports actions: react, send.");
    expect(unscopedTool.description).toContain("Supports actions: send.");
    expect(scopedTool.description).not.toContain("telegram (");
    expect(unscopedTool.description).not.toContain("telegram (");
  });

  it("routes full discovery context into plugin action discovery", () => {
    const seenContexts: Record<string, unknown>[] = [];
    const contextPlugin = createChannelPlugin({
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
      blurb: "Discord context plugin.",
      describeMessageTool: (ctx) => {
        seenContexts.push({ phase: "describeMessageTool", ...ctx });
        return {
          actions: ["send", "react"],
          capabilities: ["presentation"],
        };
      },
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: contextPlugin }]),
    );

    createMessageTool({
      config: {} as never,
      currentChannelProvider: "discord",
      currentChannelId: "channel:123",
      currentThreadTs: "thread-456",
      currentMessageId: "msg-789",
      agentAccountId: "ops",
      agentSessionKey: "agent:alpha:main",
      sessionId: "session-123",
      requesterSenderId: "user-42",
    });

    const context = seenContexts.find((item) => item.phase === "describeMessageTool");
    if (!context) {
      throw new Error("Expected describeMessageTool discovery context");
    }
    expect(context.currentChannelProvider).toBe("discord");
    expect(context.currentChannelId).toBe("channel:123");
    expect(context.currentThreadTs).toBe("thread-456");
    expect(context.currentMessageId).toBe("msg-789");
    expect(context?.accountId).toBe("ops");
    expect(context?.sessionKey).toBe("agent:alpha:main");
    expect(context?.sessionId).toBe("session-123");
    expect(context?.agentId).toBe("alpha");
    expect(context?.requesterSenderId).toBe("user-42");
  });

  it("forwards senderIsOwner into plugin action discovery", () => {
    const seenContexts: Record<string, unknown>[] = [];
    const ownerAwarePlugin = createChannelPlugin({
      id: "matrix",
      label: "Matrix",
      docsPath: "/channels/matrix",
      blurb: "Matrix owner-aware plugin.",
      describeMessageTool: (ctx) => {
        seenContexts.push(ctx);
        return {
          actions: ctx.senderIsOwner === false ? ["send"] : ["send", "set-profile"],
        };
      },
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", source: "test", plugin: ownerAwarePlugin }]),
    );

    const ownerTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "matrix",
      senderIsOwner: true,
    });
    const nonOwnerTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "matrix",
      senderIsOwner: false,
    });

    expect(getActionEnum(getToolProperties(ownerTool))).toContain("set-profile");
    expect(getActionEnum(getToolProperties(nonOwnerTool))).not.toContain("set-profile");
    expect(seenContexts.some((context) => context.senderIsOwner === true)).toBe(true);
    expect(seenContexts.some((context) => context.senderIsOwner === false)).toBe(true);
  });

  it("keeps core send and broadcast actions in unscoped schemas", () => {
    const tool = createMessageTool({
      config: {} as never,
    });

    const actionEnum = getActionEnum(getToolProperties(tool));
    expect(actionEnum).toContain("send");
    expect(actionEnum).toContain("broadcast");
  });

  it("advertises Slack download-file fileId in scoped schemas", () => {
    const slackFilePlugin = createChannelPlugin({
      id: "slack",
      label: "Slack",
      docsPath: "/channels/slack",
      blurb: "Slack test plugin.",
      actions: ["download-file"],
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackFilePlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "slack",
    });
    const properties = getToolProperties(tool);

    expect(getActionEnum(properties)).toContain("download-file");
    expectStringSchema(properties.fileId);
  });

  it("advertises messageId for read actions", () => {
    const slackReadPlugin = createChannelPlugin({
      id: "slack",
      label: "Slack",
      docsPath: "/channels/slack",
      blurb: "Slack test plugin.",
      actions: ["read"],
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackReadPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "slack",
    });
    const properties = getToolProperties(tool);

    expect(getActionEnum(properties)).toContain("read");
    expectStringSchema(properties.messageId, {
      description:
        "Target message id for read, reaction, edit, delete, pin, or unpin. If omitted for reaction-like actions, defaults to the current inbound message id when available.",
    });
  });
});

describe("message tool description", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  const imessagePlugin = createChannelPlugin({
    id: "imessage",
    label: "iMessage",
    docsPath: "/channels/imessage",
    blurb: "iMessage test plugin.",
    describeMessageTool: ({ currentChannelId }) => {
      const all: ChannelMessageActionName[] = [
        "react",
        "renameGroup",
        "addParticipant",
        "removeParticipant",
        "leaveGroup",
      ];
      const lowered = currentChannelId?.toLowerCase() ?? "";
      const isDmTarget =
        lowered.includes("chat_guid:imessage;-;") || lowered.includes("chat_guid:sms;-;");
      return {
        actions: isDmTarget
          ? all.filter(
              (action) =>
                action !== "renameGroup" &&
                action !== "addParticipant" &&
                action !== "removeParticipant" &&
                action !== "leaveGroup",
            )
          : all,
      };
    },
    messaging: {
      normalizeTarget: (raw) => {
        const trimmed = raw.trim().replace(/^imessage:/i, "");
        const lower = trimmed.toLowerCase();
        if (lower.startsWith("chat_guid:")) {
          const guid = trimmed.slice("chat_guid:".length);
          const parts = guid.split(";");
          if (parts.length === 3 && parts[1] === "-") {
            return parts[2]?.trim() || trimmed;
          }
          return `chat_guid:${guid}`;
        }
        return trimmed;
      },
    },
  });

  it("surfaces explicit cross-channel target syntax in the target schema", () => {
    const tool = createMessageTool({
      config: {} as never,
    });
    const properties = getToolProperties(tool);
    const target = properties.target as { description?: string } | undefined;

    expect(target?.description).toContain(
      "Discord/Slack/Mattermost <channelId|user:ID|channel:ID>",
    );
    expect(target?.description).toContain("Telegram chat id/@username");
  });

  it("hides iMessage group actions for DM targets", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "imessage", source: "test", plugin: imessagePlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "imessage",
      currentChannelId: "imessage:chat_guid:iMessage;-;+15551234567",
    });

    expect(tool.description).not.toContain("renameGroup");
    expect(tool.description).not.toContain("addParticipant");
    expect(tool.description).not.toContain("removeParticipant");
    expect(tool.description).not.toContain("leaveGroup");
  });

  it("describes accepted actions without channel-specific wording when currentChannel is set", () => {
    const signalPlugin = createChannelPlugin({
      id: "signal",
      label: "Signal",
      docsPath: "/channels/signal",
      blurb: "Signal test plugin.",
      actions: ["send", "react"],
    });

    const telegramPluginFull = createChannelPlugin({
      id: "telegram",
      label: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Telegram test plugin.",
      actions: ["send", "react", "delete", "edit", "topic-create"],
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "signal", source: "test", plugin: signalPlugin },
        { pluginId: "telegram", source: "test", plugin: telegramPluginFull },
      ]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });

    expect(tool.description).toContain(
      "Supports actions: delete, edit, react, send, topic-create.",
    );
    expect(tool.description).not.toContain("Current channel");
    expect(tool.description).not.toContain("Other configured channels");
    expect(tool.description).not.toContain("telegram (");
  });

  it("does not advertise cross-channel actions whose params are hidden by current-channel schema", () => {
    const signalPlugin = createChannelPlugin({
      id: "signal",
      label: "Signal",
      docsPath: "/channels/signal",
      blurb: "Signal test plugin.",
      actions: ["send", "react"],
    });
    const matrixProfilePlugin = createChannelPlugin({
      id: "matrix",
      label: "Matrix",
      docsPath: "/channels/matrix",
      blurb: "Matrix test plugin.",
      actions: ["send", "set-profile"],
      toolSchema: {
        properties: {
          displayName: Type.Optional(Type.String()),
          avatarUrl: Type.Optional(Type.String()),
        },
      },
    });

    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "signal", source: "test", plugin: signalPlugin },
        { pluginId: "matrix", source: "test", plugin: matrixProfilePlugin },
      ]),
    );

    const crossChannelTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });
    const crossChannelProperties = getToolProperties(crossChannelTool);

    expect(getActionEnum(crossChannelProperties)).not.toContain("set-profile");
    expect(crossChannelProperties.displayName).toBeUndefined();
    expect(crossChannelProperties.avatarUrl).toBeUndefined();
    expect(crossChannelTool.description).not.toContain("matrix (send, set-profile)");

    const currentChannelTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "matrix",
    });
    const currentChannelProperties = getToolProperties(currentChannelTool);

    expect(getActionEnum(currentChannelProperties)).toContain("set-profile");
    expect(currentChannelProperties).toHaveProperty("displayName");
    expect(currentChannelProperties).toHaveProperty("avatarUrl");
  });

  it("normalizes channel aliases before building the current channel description", () => {
    const signalPlugin = createChannelPlugin({
      id: "signal",
      label: "Signal",
      docsPath: "/channels/signal",
      blurb: "Signal test plugin.",
      aliases: ["sig"],
      actions: ["send", "react"],
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "sig",
    });

    expect(tool.description).toContain("Supports actions: react, send.");
    expect(tool.description).not.toContain("Current channel");
  });

  it("keeps the current-channel description stable when only one channel is configured", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "imessage", source: "test", plugin: imessagePlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "imessage",
    });

    expect(tool.description).toContain("Supports actions:");
    expect(tool.description).not.toContain("Current channel");
    expect(tool.description).not.toContain("Other configured channels");
  });

  it("includes the thread read hint when the current channel supports read", () => {
    const signalPlugin = createChannelPlugin({
      id: "signal",
      label: "Signal",
      docsPath: "/channels/signal",
      blurb: "Signal test plugin.",
      actions: ["send", "read", "react"],
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });

    expect(tool.description).toContain('Use action="read" with threadId');
  });

  it("omits the thread read hint when the current channel does not support read", () => {
    const signalPlugin = createChannelPlugin({
      id: "signal",
      label: "Signal",
      docsPath: "/channels/signal",
      blurb: "Signal test plugin.",
      actions: ["send", "react"],
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "signal",
    });

    expect(tool.description).not.toContain('Use action="read" with threadId');
  });

  it("includes the thread read hint in the generic fallback when configured actions include read", () => {
    const signalPlugin = createChannelPlugin({
      id: "signal",
      label: "Signal",
      docsPath: "/channels/signal",
      blurb: "Signal test plugin.",
      actions: ["read"],
    });

    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "signal", source: "test", plugin: signalPlugin }]),
    );

    const tool = createMessageTool({
      config: {} as never,
    });

    expect(tool.description).toContain("Supports actions:");
    expect(tool.description).toContain('Use action="read" with threadId');
  });

  it("includes broadcast in the generic fallback description", () => {
    const tool = createMessageTool({
      config: {} as never,
    });

    expect(tool.description).toContain("Supports actions: broadcast, send.");
  });
});

describe("message tool reasoning tag sanitization", () => {
  it.each([
    {
      field: "text",
      input: "<think>internal reasoning</think>Hello!",
      expected: "Hello!",
      target: "signal:+15551234567",
      channel: "signal",
    },
    {
      field: "content",
      input: "<think>reasoning here</think>Reply text",
      expected: "Reply text",
      target: "discord:123",
      channel: "discord",
    },
    {
      field: "text",
      input: "Normal message without any tags",
      expected: "Normal message without any tags",
      target: "signal:+15551234567",
      channel: "signal",
    },
    {
      field: "message",
      input: "Reasoning:\n_internal plan_\n\nVisible answer",
      expected: "Visible answer",
      target: "telegram:123",
      channel: "telegram",
    },
    {
      field: "message",
      input: "Reasoning:\n_internal plan_\n_more internal notes_",
      expected: "",
      target: "telegram:123",
      channel: "telegram",
    },
  ])(
    "sanitizes reasoning tags in $field before sending",
    async ({ channel, target, field, input, expected }) => {
      mockSendResult({ channel, to: target });

      const call = await executeSend({
        action: {
          target,
          [field]: input,
        },
      });
      expect(call?.params?.[field]).toBe(expected);
    },
  );

  it("sanitizes visible presentation text before sending", async () => {
    mockSendResult({ channel: "slack", to: "slack:C123" });

    const call = await executeSend({
      action: {
        target: "slack:C123",
        presentation: {
          title: "<think>internal title</think>Deploy ready",
          blocks: [
            { type: "text", text: "<think>internal note</think>Ship it" },
            {
              type: "buttons",
              buttons: [
                {
                  label: "<think>button rationale</think>Approve",
                  value: "approve",
                },
              ],
            },
            {
              type: "select",
              placeholder: "<think>selection rationale</think>Pick a lane",
              options: [
                {
                  label: "<think>option rationale</think>Main",
                  value: "main",
                },
              ],
            },
          ],
        },
      },
    });

    expect(call?.params?.presentation).toEqual({
      title: "Deploy ready",
      blocks: [
        { type: "text", text: "Ship it" },
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve" }],
        },
        {
          type: "select",
          placeholder: "Pick a lane",
          options: [{ label: "Main", value: "main" }],
        },
      ],
    });
  });
});

describe("message tool sandbox passthrough", () => {
  it.each([
    {
      name: "forwards sandboxRoot to runMessageAction",
      toolOptions: { sandboxRoot: "/tmp/sandbox" },
      expected: "/tmp/sandbox",
    },
    {
      name: "omits sandboxRoot when not configured",
      toolOptions: {},
      expected: undefined,
    },
  ])("$name", async ({ toolOptions, expected }) => {
    mockSendResult({ to: "telegram:123" });

    const call = await executeSend({
      toolOptions,
      action: {
        target: "telegram:123",
        message: "",
      },
    });
    expect(call?.sandboxRoot).toBe(expected);
  });

  it("forwards trusted requesterSenderId to runMessageAction", async () => {
    mockSendResult({ to: "discord:123" });

    const call = await executeSend({
      toolOptions: { requesterSenderId: "1234567890" },
      action: {
        target: "discord:123",
        message: "hi",
      },
    });

    expect(call?.requesterSenderId).toBe("1234567890");
  });

  it("forwards senderIsOwner to runMessageAction", async () => {
    mockSendResult({ to: "discord:123" });

    const call = await executeSend({
      toolOptions: { senderIsOwner: false },
      action: {
        target: "discord:123",
        message: "hi",
      },
    });

    expect(call?.senderIsOwner).toBe(false);
  });
});
