// Message tool tests cover channel action discovery, secret scoping, and
// outbound message execution context.
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGE_TOOL_ONLY_DELIVERY_HINT,
  ROOM_EVENT_DELIVERY_HINT,
} from "../../auto-reply/reply/delivery-hints.js";
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName, ChannelPlugin } from "../../channels/plugins/types.js";
import type { MessageActionRunResult } from "../../infra/outbound/message-action-runner.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "../agent-tools.before-tool-call.js";
import { CRITICAL_THRESHOLD } from "../tool-loop-detection.js";
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
      maybeCollectSecretPath(`channels.${scopedChannel}.appPassword`, scopedConfig.appPassword);
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

vi.mock("../../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/bundled.js")>(
    "../../channels/plugins/bundled.js",
  );
  // This unit suite installs minimal loaded plugins when it exercises channel actions.
  // Bundled source entry loading belongs to the loader integration suites.
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
    getBundledChannelSetupPlugin: vi.fn(() => undefined),
  };
});

type RunMessageActionInput = {
  agentId?: string;
  cfg?: unknown;
  defaultAccountId?: string;
  gateway?: {
    timeoutMs?: unknown;
  };
  params?: Record<string, unknown>;
  requesterSenderId?: string;
  sandboxRoot?: string;
  sessionKey?: string;
  sourceReplyDeliveryMode?: string;
  inboundAudio?: boolean;
  toolContext?: {
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentChannelProvider?: string;
    currentThreadTs?: string;
    replyToMode?: string;
  };
};

function firstRunMessageActionInput(): RunMessageActionInput | undefined {
  return mocks.runMessageAction.mock.calls[0]?.[0] as RunMessageActionInput | undefined;
}

function lastRunMessageActionInput(): RunMessageActionInput | undefined {
  return mocks.runMessageAction.mock.calls.at(-1)?.[0] as RunMessageActionInput | undefined;
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
  // Secret resolution is scoped to the active channel/account; tests inspect
  // the exact target set to avoid broad credential reads.
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
  resetDiagnosticSessionStateForTest();
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
  messageActionTargetAliases?: NonNullable<ChannelPlugin["actions"]>["messageActionTargetAliases"];
  message?: ChannelMessageAdapterShape;
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
    ...(params.message ? { message: params.message } : {}),
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
      messageActionTargetAliases: params.messageActionTargetAliases,
    },
  };
}

async function executeSend(params: {
  action: Record<string, unknown>;
  toolOptions?: Partial<Parameters<typeof createMessageTool>[0]>;
  toolCallId?: string;
}) {
  return (await executeSendWithResult(params)).call;
}

async function executeSendWithResult(params: {
  action: Record<string, unknown>;
  toolOptions?: Partial<Parameters<typeof createMessageTool>[0]>;
  toolCallId?: string;
}) {
  const { config, getRuntimeConfig, ...toolOptions } = params.toolOptions ?? {};
  const tool = createMessageTool({
    getRuntimeConfig: getRuntimeConfig ?? (config ? () => config : mocks.getRuntimeConfig),
    runMessageAction: mocks.runMessageAction as never,
    ...toolOptions,
  });
  const result = await tool.execute(params.toolCallId ?? "1", {
    action: "send",
    ...params.action,
  });
  return { call: lastRunMessageActionInput(), result };
}

describe("message tool gateway timeout", () => {
  it("advertises timeoutMs as a positive integer", () => {
    const tool = createMessageTool();
    expect(getToolProperties(tool).timeoutMs).toMatchObject({ type: "integer", minimum: 1 });
  });

  it("advertises shared poll duration as a positive integer", () => {
    const tool = createMessageTool();
    expect(getToolProperties(tool).pollDurationHours).toMatchObject({
      type: "integer",
      minimum: 1,
    });
  });

  it("advertises shared action numeric params with runtime integer bounds", () => {
    const properties = getToolProperties(createMessageTool());

    for (const name of ["limit", "pageSize", "autoArchiveMin"]) {
      expect(properties[name]).toMatchObject({ type: "integer", minimum: 1 });
    }
    for (const name of ["durationMin", "position", "rateLimitPerUser"]) {
      expect(properties[name]).toMatchObject({ type: "integer", minimum: 0 });
    }
    expect(properties.deleteDays).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 7,
    });
    expect(properties.channelType).toMatchObject({ type: "integer", minimum: 0 });
    expect(properties.pollOptionIndex).toMatchObject({ type: "integer", minimum: 1 });
    expect(properties.pollOptionIndexes).toMatchObject({
      type: "array",
      items: { type: "integer", minimum: 1 },
    });
  });

  it.each([-1, 1.5, "fast"])(
    "rejects invalid timeoutMs value %s before dispatch",
    async (timeoutMs) => {
      mockSendResult();
      const tool = createMessageTool({
        runMessageAction: mocks.runMessageAction as never,
      });

      await expect(
        tool.execute("1", {
          action: "send",
          target: "telegram:123",
          message: "hi",
          timeoutMs,
        }),
      ).rejects.toThrow("timeoutMs must be a positive integer");
      expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
      expect(mocks.runMessageAction).not.toHaveBeenCalled();
    },
  );

  it("accepts string timeoutMs values through the shared numeric reader", async () => {
    mockSendResult();

    const call = await executeSend({
      action: {
        target: "telegram:123",
        message: "hi",
        timeoutMs: "5000",
      },
    });

    expect(call?.gateway?.timeoutMs).toBe(5000);
  });
});

describe("poll vote echo guard", () => {
  const currentChat = "iMessage;-;+15550001111";
  let sessionKeyCounter = 0;

  // The echo record is session-scoped so it survives the run boundary between a
  // vote and the follow-up text. Give each tool a unique session key so tests
  // stay isolated; a shared key would cross-contaminate via the module map.
  function createPollVoteTool(votedOption = "Blue", agentSessionKey?: string) {
    const sessionKey = agentSessionKey ?? `agent:test:imessage:direct:s${(sessionKeyCounter += 1)}`;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createChannelPlugin({
            id: "imessage",
            label: "iMessage",
            docsPath: "/channels/imessage",
            blurb: "iMessage test plugin",
            actions: ["poll-vote"],
            messageActionTargetAliases: {
              "poll-vote": {
                aliases: ["chatGuid"],
                deliveryTargetAliases: ["chatGuid"],
              },
            },
          }),
        },
      ]),
    );
    mocks.runMessageAction.mockImplementation(async ({ action }: { action: string }) =>
      action === "poll-vote"
        ? ({
            kind: "action",
            channel: "imessage",
            action: "poll-vote",
            handledBy: "plugin",
            payload: {},
            toolResult: {
              content: [{ type: "text", text: "vote cast" }],
              details: { pollVotedOption: votedOption },
            },
            dryRun: false,
          } as MessageActionRunResult)
        : ({
            kind: "send",
            channel: "imessage",
            action: "send",
            to: currentChat,
            handledBy: "plugin",
            payload: {},
            dryRun: false,
          } as MessageActionRunResult),
    );
    return createMessageTool({
      currentChannelProvider: "imessage",
      currentChannelId: currentChat,
      agentAccountId: "primary",
      agentSessionKey: sessionKey,
      sourceReplyDeliveryMode: "message_tool_only",
      runMessageAction: mocks.runMessageAction as never,
    });
  }

  async function castBlueVote(
    tool: ReturnType<CreateMessageTool>,
    overrides: Record<string, unknown> = {},
  ) {
    await tool.execute("vote", {
      action: "poll-vote",
      channel: "imessage",
      pollId: "poll-guid",
      pollOptionIndex: 2,
      ...overrides,
    });
  }

  it("suppresses the first same-route restatement", async () => {
    const tool = createPollVoteTool();
    await castBlueVote(tool);

    const result = await tool.execute("send", {
      action: "send",
      channel: "imessage",
      message: "🦞 Blue.",
    });

    expect(result.details).toMatchObject({ status: "suppressed", reason: "poll_vote_echo" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("suppresses an echo that lands in a later run (new tool instance, same session)", async () => {
    // The live failure: a native poll and its comment arrive as separate inbound
    // messages, so the vote and the restatement run in different agent turns with
    // fresh tool instances. A session-scoped record must still catch the reply.
    const sessionKey = "agent:test:imessage:direct:cross-run";
    const voteTool = createPollVoteTool("Black", sessionKey);
    await castBlueVote(voteTool);

    const nextRunTool = createPollVoteTool("Black", sessionKey);
    const result = await nextRunTool.execute("send", {
      action: "send",
      channel: "imessage",
      message: "🦞 Black.",
    });

    expect(result.details).toMatchObject({ status: "suppressed", reason: "poll_vote_echo" });
  });

  it("does not suppress a later-run echo from a different conversation", async () => {
    const voteTool = createPollVoteTool("Black", "agent:test:imessage:direct:convo-a");
    await castBlueVote(voteTool);
    const otherTool = createPollVoteTool("Black", "agent:test:imessage:direct:convo-b");
    await otherTool.execute("send", {
      action: "send",
      channel: "imessage",
      message: "🦞 Black.",
    });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
  });

  it("suppresses an emoji-suffixed option echoed with a leading emoji", async () => {
    // Live regression: iMessage poll options carry a trailing emoji
    // ("Lobster 🦞 ") while the agent echoes a leading one ("🦞 Lobster.").
    // A leading-only emoji strip left "lobster 🦞" != "lobster" and leaked.
    const tool = createPollVoteTool("Lobster 🦞 ");
    await castBlueVote(tool);

    const result = await tool.execute("send", {
      action: "send",
      channel: "imessage",
      message: "🦞 Lobster.",
    });

    expect(result.details).toMatchObject({ status: "suppressed", reason: "poll_vote_echo" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("does not suppress a different keycap option with the same words", async () => {
    const tool = createPollVoteTool("Option 1️⃣");
    await castBlueVote(tool);

    const result = await tool.execute("send", {
      action: "send",
      channel: "imessage",
      message: "2️⃣ Option.",
    });

    expect(result.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
  });

  it("does not cross accounts, delivery targets, or conflicting target fields", async () => {
    const accountTool = createPollVoteTool();
    await castBlueVote(accountTool);
    await accountTool.execute("send", {
      action: "send",
      channel: "imessage",
      accountId: "secondary",
      message: "Blue",
    });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);

    const targetTool = createPollVoteTool();
    await castBlueVote(targetTool, { chatGuid: "iMessage;-;+15559998888" });
    await targetTool.execute("send", {
      action: "send",
      channel: "imessage",
      message: "Blue",
    });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(4);

    const conflictingTool = createPollVoteTool();
    await castBlueVote(conflictingTool, {
      target: currentChat,
      chatGuid: "iMessage;-;+15559998888",
    });
    await conflictingTool.execute("send", {
      action: "send",
      channel: "imessage",
      target: currentChat,
      message: "Blue",
    });

    expect(mocks.runMessageAction).toHaveBeenCalledTimes(6);
  });

  it("consumes the guard on the first same-route visible send", async () => {
    const tool = createPollVoteTool();
    await castBlueVote(tool);
    await tool.execute("send-1", {
      action: "send",
      channel: "imessage",
      message: "Blue, because it matches our theme",
    });
    await tool.execute("send-2", {
      action: "send",
      channel: "imessage",
      message: "Blue",
    });

    expect(mocks.runMessageAction).toHaveBeenCalledTimes(3);
  });
});

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
      'use action="send" with message for visible replies to the current source conversation',
    );
    expect(scopedTool.description).toContain("target defaults to the current source conversation");
    expect(scopedTool.description).toContain("Normal final answers stay private");
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
      'use action="send" with message for visible replies to the current source conversation',
    );
  });

  it("passes source reply delivery mode to the outbound runner", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("webchat");
  });

  it("defaults internal WebChat message tool sends to the source-reply sink", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:webchat:dm:dashboard",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("webchat");
    expect(input?.params).toMatchObject({ action: "send", message: "hi" });
  });

  it("keeps automatic WebChat final-answer guidance while selecting the tool-local sink", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        currentChannelProvider: "webchat",
        sourceReplyDeliveryMode: "automatic",
        agentSessionKey: "agent:main:webchat:dm:dashboard",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("webchat");
    const tool = createMessageTool({
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "automatic",
      agentSessionKey: "agent:main:webchat:dm:dashboard",
    });
    expect(tool.description).not.toContain("Normal final answers stay private");
  });

  it("passes current inbound audio to the outbound runner", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        currentInboundAudio: true,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "telegram",
        agentSessionKey: "agent:main:telegram:direct:123456789",
      },
    });

    expect(input?.inboundAudio).toBe(true);
    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("reads steered inbound audio when the message action runs", async () => {
    mockSendResult();
    let hasCurrentInboundAudio = false;
    const tool = createMessageTool({
      currentInboundAudio: false,
      hasCurrentInboundAudio: () => hasCurrentInboundAudio,
      sourceReplyDeliveryMode: "message_tool_only",
      currentChannelProvider: "whatsapp",
      agentSessionKey: "agent:main:whatsapp:direct:123456789",
      runMessageAction: mocks.runMessageAction as never,
    });
    hasCurrentInboundAudio = true;

    await tool.execute("call1", { action: "send", message: "hi" });

    expect(lastRunMessageActionInput()?.inboundAudio).toBe(true);
  });

  it("adds a current-run idempotency key when the model omits one", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: { runId: "run-message-tool" },
    });

    expect(input?.params?.idempotencyKey).toMatch(
      /^run-message-tool:message-tool:[A-Za-z0-9_-]+:[A-Za-z0-9._:-]+$/,
    );
  });

  it("reuses the unresolved autogenerated idempotency key for exact retries", async () => {
    mocks.runMessageAction
      .mockRejectedValueOnce(new Error("gateway timeout"))
      .mockResolvedValueOnce({
        kind: "send",
        action: "send",
        channel: "telegram",
        to: "telegram:123",
        handledBy: "plugin",
        payload: {},
        dryRun: true,
      } satisfies MessageActionRunResult);

    const tool = createMessageTool({
      getRuntimeConfig: mocks.getRuntimeConfig,
      runMessageAction: mocks.runMessageAction as never,
      runId: "run-message-tool",
    });

    await expect(
      tool.execute("message_111_1", {
        action: "send",
        message: "same",
        to: "123",
        timeoutMs: 1,
      }),
    ).rejects.toThrow("gateway timeout");
    const first = firstRunMessageActionInput();

    await tool.execute("message_222_1", {
      action: "send",
      timeoutMs: 30_000,
      to: "123",
      message: "same",
    });
    const second = lastRunMessageActionInput();

    expect(first?.params?.idempotencyKey).toBe(second?.params?.idempotencyKey);
  });

  it("uses delivery params to avoid collisions across distinct sends", async () => {
    mockSendResult();

    const first = await executeSend({
      action: { message: "first" },
      toolOptions: { runId: "run-message-tool" },
      toolCallId: "message_111_1",
    });
    const second = await executeSend({
      action: { message: "second" },
      toolOptions: { runId: "run-message-tool" },
      toolCallId: "message_222_1",
    });

    expect(first?.params?.idempotencyKey).not.toBe(second?.params?.idempotencyKey);
  });

  it("uses a fresh autogenerated idempotency key after a successful identical send", async () => {
    mockSendResult();

    const tool = createMessageTool({
      getRuntimeConfig: mocks.getRuntimeConfig,
      runMessageAction: mocks.runMessageAction as never,
      runId: "run-message-tool",
    });

    await tool.execute("message_111_1", {
      action: "send",
      message: "same",
      to: "123",
    });
    const first = firstRunMessageActionInput();
    await tool.execute("message_222_1", {
      action: "send",
      to: "123",
      message: "same",
    });
    const second = lastRunMessageActionInput();

    expect(first?.params?.idempotencyKey).not.toBe(second?.params?.idempotencyKey);
  });

  it("uses separate autogenerated idempotency keys for parallel identical sends", async () => {
    const pending: Array<(value: MessageActionRunResult) => void> = [];
    mocks.runMessageAction.mockImplementation(
      () =>
        new Promise<MessageActionRunResult>((resolve) => {
          pending.push(resolve);
        }),
    );

    const tool = createMessageTool({
      getRuntimeConfig: mocks.getRuntimeConfig,
      runMessageAction: mocks.runMessageAction as never,
      runId: "run-message-tool",
    });

    const firstResult = tool.execute("message_111_1", {
      action: "send",
      message: "same",
      to: "123",
    });
    const secondResult = tool.execute("message_222_1", {
      action: "send",
      to: "123",
      message: "same",
    });

    for (let i = 0; i < 10 && mocks.runMessageAction.mock.calls.length < 2; i += 1) {
      await Promise.resolve();
    }
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
    const first = mocks.runMessageAction.mock.calls[0]?.[0] as RunMessageActionInput | undefined;
    const second = mocks.runMessageAction.mock.calls[1]?.[0] as RunMessageActionInput | undefined;
    expect(first?.params?.idempotencyKey).not.toBe(second?.params?.idempotencyKey);

    for (const resolve of pending) {
      resolve({
        kind: "send",
        action: "send",
        channel: "telegram",
        to: "telegram:123",
        handledBy: "plugin",
        payload: {},
        dryRun: true,
      });
    }
    await Promise.all([firstResult, secondResult]);
  });

  it("keeps nested delivery fields in autogenerated idempotency keys", async () => {
    mockSendResult();

    const first = await executeSend({
      action: {
        message: "pay",
        channelData: { button: { idempotencyKey: "invoice-A" } },
      },
      toolOptions: { runId: "run-message-tool" },
    });
    const second = await executeSend({
      action: {
        message: "pay",
        channelData: { button: { idempotencyKey: "invoice-B" } },
      },
      toolOptions: { runId: "run-message-tool" },
    });

    expect(first?.params?.idempotencyKey).not.toBe(second?.params?.idempotencyKey);
  });

  it("uses a non-webchat session key when ambient current channel drifted to webchat", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            telegram: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:telegram:group:-5150615830",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("telegram");
    expect(input?.toolContext?.currentChannelId).toBe("-5150615830");
    expect(input?.params).toEqual({ action: "send", message: "hi" });

    const secretResolveCall = latestSecretResolveCall();
    expect(Array.from(secretResolveCall.targetIds ?? [])).toEqual(["channels.telegram.botToken"]);
  });

  it("preserves empty opaque target segments in inferred session delivery", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            telegram: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:telegram:group:room::part",
      },
    });

    expect(input?.toolContext?.currentChannelProvider).toBe("telegram");
    expect(input?.toolContext?.currentChannelId).toBe("room::part");
  });

  it("does not infer delivery from empty structural session segments", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            telegram: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:telegram::group:room",
      },
    });

    expect(input?.toolContext?.currentChannelProvider).toBe("webchat");
    expect(input?.toolContext?.currentChannelId).toBeUndefined();
  });

  it("does not infer delivery from a nested opaque agent identity", async () => {
    mockSendResult();

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {} as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:voice:agent:channel:room",
      },
    });

    expect(input?.toolContext?.currentChannelProvider).toBe("webchat");
    expect(input?.toolContext?.currentChannelId).toBeUndefined();
  });

  it("preserves direct session keys as explicit user targets when ambient channel drifted to webchat", async () => {
    mockSendResult({ channel: "discord", to: "user:123456789" });

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            discord: {
              token: { source: "env", provider: "default", id: "DISCORD_TOKEN" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:discord:direct:123456789",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("discord");
    expect(input?.toolContext?.currentChannelId).toBe("user:123456789");
    expect(input?.params).toEqual({ action: "send", message: "hi" });

    const secretResolveCall = latestSecretResolveCall();
    expect(Array.from(secretResolveCall.targetIds ?? [])).toEqual(["channels.discord.token"]);
  });

  it("preserves MS Teams DM session keys as explicit user targets when ambient channel drifted to webchat", async () => {
    mockSendResult({ channel: "msteams", to: "user:user-1" });

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            msteams: {
              appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:msteams:dm:user-1",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("msteams");
    expect(input?.toolContext?.currentChannelId).toBe("user:user-1");
    expect(input?.params).toEqual({ action: "send", message: "hi" });

    const secretResolveCall = latestSecretResolveCall();
    expect(Array.from(secretResolveCall.targetIds ?? [])).toEqual(["channels.msteams.appPassword"]);
  });

  it("keeps provider-native direct session targets when ambient channel drifted to webchat", async () => {
    mockSendResult({ channel: "telegram", to: "123456789" });

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            telegram: {
              botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:telegram:direct:123456789",
      },
    });

    expect(input?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(input?.toolContext?.currentChannelProvider).toBe("telegram");
    expect(input?.toolContext?.currentChannelId).toBe("123456789");
    expect(input?.params).toEqual({ action: "send", message: "hi" });

    const secretResolveCall = latestSecretResolveCall();
    expect(Array.from(secretResolveCall.targetIds ?? [])).toEqual(["channels.telegram.botToken"]);
  });

  it("uses account-scoped session keys for secret and account fallback when ambient channel drifted to webchat", async () => {
    mockSendResult({ channel: "discord", to: "user:123456789" });

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            discord: {
              token: { source: "env", provider: "default", id: "DISCORD_TOKEN" },
              accounts: {
                ops: { token: { source: "env", provider: "default", id: "DISCORD_OPS_TOKEN" } },
              },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:discord:ops:direct:123456789",
      },
    });

    expect(input?.defaultAccountId).toBe("ops");
    expect(input?.params?.accountId).toBe("ops");
    expect(input?.toolContext?.currentChannelProvider).toBe("discord");
    expect(input?.toolContext?.currentChannelId).toBe("user:123456789");

    const secretResolveCall = latestSecretResolveCall();
    expect(Array.from(secretResolveCall.targetIds ?? [])).toEqual([
      "channels.discord.token",
      "channels.discord.accounts.ops.token",
    ]);
  });

  it("keeps account-scoped direct keys when account id matches a peer marker", async () => {
    mockSendResult({ channel: "discord", to: "user:123456789" });

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            discord: {
              token: { source: "env", provider: "default", id: "DISCORD_TOKEN" },
              accounts: {
                direct: {
                  token: { source: "env", provider: "default", id: "DISCORD_DIRECT_TOKEN" },
                },
              },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:discord:direct:direct:123456789",
      },
    });

    expect(input?.defaultAccountId).toBe("direct");
    expect(input?.params?.accountId).toBe("direct");
    expect(input?.toolContext?.currentChannelProvider).toBe("discord");
    expect(input?.toolContext?.currentChannelId).toBe("user:123456789");

    const secretResolveCall = latestSecretResolveCall();
    expect(Array.from(secretResolveCall.targetIds ?? [])).toEqual([
      "channels.discord.token",
      "channels.discord.accounts.direct.token",
    ]);
  });

  it("handles legacy dm markers when ambient channel drifted to webchat", async () => {
    mockSendResult({ channel: "slack", to: "user:u123" });

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            slack: {
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:slack:dm:u123:thread:171.222",
      },
    });

    expect(input?.toolContext?.currentChannelProvider).toBe("slack");
    expect(input?.toolContext?.currentChannelId).toBe("user:u123");
    expect(input?.toolContext?.currentThreadTs).toBe("171.222");
    expect(input?.toolContext?.replyToMode).toBe("all");

    const secretResolveCall = latestSecretResolveCall();
    expect(Array.from(secretResolveCall.targetIds ?? [])).toEqual(["channels.slack.botToken"]);
  });

  it("carries session-key thread suffixes into inferred channel context", async () => {
    mockSendResult({ channel: "slack", to: "channel:c1" });

    const input = await executeSend({
      action: { message: "hi" },
      toolOptions: {
        config: {
          channels: {
            slack: {
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
            },
          },
        } as never,
        sourceReplyDeliveryMode: "message_tool_only",
        currentChannelProvider: "webchat",
        agentSessionKey: "agent:main:slack:channel:c1:thread:1710000000.9999",
      },
    });

    expect(input?.toolContext?.currentChannelProvider).toBe("slack");
    expect(input?.toolContext?.currentChannelId).toBe("c1");
    expect(input?.toolContext?.currentThreadTs).toBe("1710000000.9999");
    expect(input?.toolContext?.replyToMode).toBe("all");
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
    const plugin = createChannelPlugin({
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
      blurb: "test",
      actions: ["send"],
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
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

describe("message tool delivery mode schema", () => {
  it("hides bestEffort when required durable delivery is not available", () => {
    const plugin = createChannelPlugin({
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
      blurb: "test",
      actions: ["send"],
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));

    const defaultTool = createMessageTool();
    const scopedTool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "discord",
    });

    expect(getToolProperties(defaultTool).bestEffort).toBeUndefined();
    expect(getToolProperties(scopedTool).bestEffort).toBeUndefined();
  });

  it("exposes bestEffort only for channels that can reconcile unknown sends", () => {
    const plugin = createChannelPlugin({
      id: "discord",
      label: "Discord",
      docsPath: "/channels/discord",
      blurb: "test",
      actions: ["send"],
      message: {
        durableFinal: {
          capabilities: { reconcileUnknownSend: true },
          reconcileUnknownSend: async () => ({ status: "not_sent" }),
        },
      },
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "discord",
    });
    const bestEffort = getToolProperties(tool).bestEffort as
      | { description?: string; type?: string }
      | undefined;

    expect(bestEffort?.type).toBe("boolean");
    expect(bestEffort?.description).toContain("required durable delivery");
  });
});

describe("message tool agent routing", () => {
  it("derives agentId from the session key", async () => {
    mockSendResult();

    const tool = createMessageTool({
      agentSessionKey: "agent:alpha:main",
      getRuntimeConfig: mocks.getRuntimeConfig,
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
      getRuntimeConfig: mocks.getRuntimeConfig,
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
      getRuntimeConfig: mocks.getRuntimeConfig,
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
    const plugin = createChannelPlugin({
      id: "slack",
      label: "Slack",
      docsPath: "/channels/slack",
      blurb: "test",
      actions: ["send"],
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", source: "test", plugin }]));

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

  it("forwards the routable target through createOpenClawTools to the message tool", async () => {
    mockSendResult({ channel: "slack", to: "user:U123" });
    const plugin = createChannelPlugin({
      id: "slack",
      label: "Slack",
      docsPath: "/channels/slack",
      blurb: "test",
      actions: ["send"],
    });
    setActivePluginRegistry(createTestRegistry([{ pluginId: "slack", source: "test", plugin }]));

    const tool = createOpenClawTools({
      config: {} as never,
      agentChannel: "slack",
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      currentThreadTs: "111.222",
      replyToMode: "all",
    }).find((candidate) => candidate.name === "message");

    if (!tool) {
      throw new Error("message tool not found");
    }

    await tool.execute("1", {
      action: "send",
      channel: "slack",
      target: "user:U123",
      message: "stay in DM thread",
    });

    const call = firstRunMessageActionInput();
    expect(call?.toolContext).toMatchObject({
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      currentChannelProvider: "slack",
      currentThreadTs: "111.222",
      replyToMode: "all",
    });
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

  it.each([
    {
      action: "poll",
      params: {
        action: "poll",
        pollQuestion: "Lunch?",
        pollOption: ["Pizza", "Sushi"],
      },
    },
    {
      action: "sticker",
      params: {
        action: "sticker",
        stickerId: "sticker-1",
      },
    },
  ] as const)("requires an explicit target for $action when configured", async ({ params }) => {
    const tool = createMessageTool({
      runMessageAction: mocks.runMessageAction as never,
      requireExplicitTarget: true,
      currentChannelProvider: "slack",
      currentChannelId: "channel:C123",
    });

    await expect(tool.execute("1", params)).rejects.toThrow(/Explicit message target required/i);

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

describe("message tool loop detection action runner proof", () => {
  function mockQaChannelGatewayActionRunner() {
    mocks.runMessageAction.mockImplementation(async ({ params }) => {
      const callIndex = mocks.runMessageAction.mock.calls.length;
      return {
        kind: "send",
        action: "send",
        channel: "qa-channel",
        to: typeof params?.target === "string" ? params.target : "channel:loop-room",
        handledBy: "plugin",
        payload: {
          message: {
            id: `qa-message-${callIndex}`,
            accountId: "default",
            direction: "outbound",
            conversation: {
              id: "loop-room",
              chatType: "channel",
            },
            senderId: "openclaw",
            text: "same visible reply",
            timestamp: 1_800_000_000_000 + callIndex,
          },
        },
        dryRun: false,
      } satisfies MessageActionRunResult;
    });
  }

  it("blocks repeated qa-channel sends returned by the wrapped message tool", async () => {
    mockQaChannelGatewayActionRunner();
    const messageTool = createMessageTool({
      runMessageAction: mocks.runMessageAction as never,
    });
    const wrappedTool = wrapToolWithBeforeToolCallHook(messageTool, {
      agentId: "main",
      sessionKey: "message-tool-action-runner-loop",
      sessionId: "message-tool-action-runner-loop-session",
      runId: "message-tool-action-runner-loop-run",
      loopDetection: { enabled: true },
    });
    const params = {
      action: "send",
      target: "channel:loop-room",
      message: "same visible reply",
    };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      const result = await wrappedTool.execute(`message-tool-send-${i}`, params);
      expect(result.details).toMatchObject({
        message: {
          conversation: {
            id: "loop-room",
          },
          text: "same visible reply",
        },
      });
    }

    const blocked = await wrappedTool.execute(`message-tool-send-${CRITICAL_THRESHOLD}`, params);
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(CRITICAL_THRESHOLD);
    expect(blocked.details).toMatchObject({
      status: "blocked",
      deniedReason: "tool-loop",
    });
    const blockedDetails = blocked.details as { reason?: unknown } | undefined;
    expect(String(blockedDetails?.reason)).toContain("CRITICAL");

    const blockedAgain = await wrappedTool.execute(
      `message-tool-send-${CRITICAL_THRESHOLD + 1}`,
      params,
    );
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(CRITICAL_THRESHOLD);
    expect(blockedAgain.details).toMatchObject({
      status: "blocked",
      deniedReason: "tool-loop",
    });
  });
});

describe("message tool path passthrough", () => {
  it("advertises canonical media params without compat aliases", () => {
    const properties = getToolProperties(createMessageTool());
    const attachments = properties.attachments as
      | { items?: { properties?: Record<string, unknown> } }
      | undefined;
    const attachmentProperties = attachments?.items?.properties ?? {};

    expect(properties).toHaveProperty("media");
    expect(properties).not.toHaveProperty("mediaUrl");
    expect(properties).not.toHaveProperty("mediaUrls");
    expect(properties).not.toHaveProperty("path");
    expect(properties).not.toHaveProperty("filePath");
    expect(properties).not.toHaveProperty("fileUrl");
    expect(attachmentProperties).toHaveProperty("media");
    for (const name of ["mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      expect(attachmentProperties).not.toHaveProperty(name);
    }
  });

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
      const presentationSchemaJson = JSON.stringify(properties.presentation);

      expect(properties).toHaveProperty("presentation");
      expect(presentationSchemaJson).toContain('"action"');
      expect(presentationSchemaJson).toContain('"command"');
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

  it("passes sender ownership into plugin action discovery", () => {
    const seenContexts: Record<string, unknown>[] = [];
    const plugin = createChannelPlugin({
      id: "matrix",
      label: "Matrix",
      docsPath: "/channels/matrix",
      blurb: "Matrix plugin.",
      describeMessageTool: (ctx) => {
        seenContexts.push(ctx);
        return {
          actions: ["send", "set-profile"],
        };
      },
    });

    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));

    const tool = createMessageTool({
      config: {} as never,
      currentChannelProvider: "matrix",
      senderIsOwner: true,
    });

    expect(getActionEnum(getToolProperties(tool))).toContain("set-profile");
    expect(seenContexts.some((ctx) => ctx.senderIsOwner === true)).toBe(true);
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
        "Target message id for read/react/edit/delete/pin/unpin. Reaction-like defaults current inbound id when available.",
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

  it("describes userId as required directly for member-info, not via target", () => {
    const tool = createMessageTool({
      config: {} as never,
    });
    const properties = getToolProperties(tool);
    const userId = properties.userId as { description?: string } | undefined;

    expect(userId?.description).toMatch(/member-info/i);
    expect(userId?.description).toMatch(/not.*`target`|does not accept.*target/i);
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
      input: "Thinking...\nI'll check that now",
      expected: "Thinking...\nI'll check that now",
      target: "telegram:123",
      channel: "telegram",
    },
    {
      field: "message",
      input: "Thinking\n_internal plan_\n\nVisible answer",
      expected: "Visible answer",
      target: "telegram:123",
      channel: "telegram",
    },
    {
      field: "message",
      input: "Thinking\n_internal plan_\n_more internal notes_",
      expected: "",
      target: "telegram:123",
      channel: "telegram",
    },
    {
      field: "message",
      input: "Reasoning:\n_internal plan_\n\nVisible answer",
      expected: "Visible answer",
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
                  action: { type: "command", command: "/codex approve" },
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
          buttons: [
            {
              label: "Approve",
              action: { type: "command", command: "/codex approve" },
              value: "approve",
            },
          ],
        },
        {
          type: "select",
          placeholder: "Pick a lane",
          options: [{ label: "Main", value: "main" }],
        },
      ],
    });
  });

  it("strips internal runtime context from visible presentation fields before sending (#53732)", async () => {
    mockSendResult({ channel: "slack", to: "slack:C123" });

    const internalContext =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const call = await executeSend({
      action: {
        target: "slack:C123",
        presentation: {
          title: `Deploy ready\n${internalContext}`,
          blocks: [
            { type: "text", text: `Ship it\n${internalContext}` },
            {
              type: "input",
              placeholder: `Pick a lane\n${internalContext}`,
            },
            {
              type: "buttons",
              buttons: [
                {
                  label: `Approve\n${internalContext}`,
                  value: "approve",
                },
              ],
            },
            {
              type: "select",
              options: [
                {
                  label: `Main\n${internalContext}`,
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
        { type: "input", placeholder: "Pick a lane" },
        {
          type: "buttons",
          buttons: [{ label: "Approve", value: "approve" }],
        },
        {
          type: "select",
          options: [{ label: "Main", value: "main" }],
        },
      ],
    });
  });
});

describe("message tool boot-echo guard", () => {
  const longBootPrompt = [
    "You are running a boot check. Follow BOOT.md instructions exactly.",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
    "This context is runtime-generated, not user-authored. Keep internal details private.",
    "",
    "BOOT.md:",
    "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel and report the active project status with three concrete bullet points.",
    "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    "If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
  ].join("\n");

  let setBootEchoContextForSession: typeof import("../../gateway/boot-echo-guard.js").setBootEchoContextForSession;
  let resetBootEchoContextForTests: typeof import("../../gateway/boot-echo-guard.js").resetBootEchoContextForTests;

  beforeAll(async () => {
    ({ setBootEchoContextForSession, resetBootEchoContextForTests } =
      await import("../../gateway/boot-echo-guard.js"));
  });

  afterEach(() => {
    resetBootEchoContextForTests();
  });

  it("suppresses text-only sends that echo a substantial chunk of the registered boot prompt without preserving the wrapper markers (#53732)", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);

    // The model is paraphrasing out the wrapper but copying the BOOT.md
    // sentence verbatim — exactly the leak vector clawsweeper called out
    // on #75128 that the marker-only strip would miss.
    const echoedText =
      "Here is what I was told: When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    const { call, result } = await executeSendWithResult({
      action: {
        target: "telegram:123",
        text: echoedText,
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call).toBeUndefined();
    expect(mocks.runMessageAction).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "suppressed",
      reason: "internal_runtime_context_echo",
    });
    expect(JSON.stringify(result)).not.toContain("thoughtful greeting");
  });

  it("sanitizes boot echo text and still sends when media content remains", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const echoedText =
      "Here is what I was told: When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    const call = await executeSend({
      action: {
        target: "telegram:123",
        text: echoedText,
        mediaUrl: "file:///tmp/status.png",
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call?.params?.text).toBe("");
    expect(call?.params?.mediaUrl).toBe("file:///tmp/status.png");
  });

  it("sanitizes boot echo text and still sends when snake_case media content remains", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const echoedText =
      "Here is what I was told: When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    const call = await executeSend({
      action: {
        target: "telegram:123",
        text: echoedText,
        media_url: "file:///tmp/status.png",
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call?.params?.text).toBe("");
    expect(call?.params?.media_url).toBe("file:///tmp/status.png");
  });

  it("sanitizes boot echo text and still sends when snake_case media arrays remain", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const echoedText =
      "Here is what I was told: When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    const call = await executeSend({
      action: {
        target: "telegram:123",
        text: echoedText,
        media_urls: ["file:///tmp/one.png", "file:///tmp/two.png"],
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call?.params?.text).toBe("");
    expect(call?.params?.media_urls).toEqual(["file:///tmp/one.png", "file:///tmp/two.png"]);
  });

  it("sanitizes boot echo text and still sends when structured attachments remain", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const echoedText =
      "Here is what I was told: When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    const call = await executeSend({
      action: {
        target: "telegram:123",
        message: echoedText,
        attachments: [{ media: "file:///tmp/status.png" }],
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call?.params?.message).toBe("");
    expect(call?.params?.attachments).toEqual([{ media: "file:///tmp/status.png" }]);
  });

  it("sanitizes boot echo text and still sends when structured attachment aliases remain", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const echoedText =
      "Here is what I was told: When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    const call = await executeSend({
      action: {
        target: "telegram:123",
        message: echoedText,
        attachments: [{ file_path: "/tmp/status.png" }],
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call?.params?.message).toBe("");
    expect(call?.params?.attachments).toEqual([{ file_path: "/tmp/status.png" }]);
  });

  it("preserves a short legitimate BOOT.md-directed send that does not reproduce a long boot-prompt chunk", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const call = await executeSend({
      action: {
        target: "telegram:123",
        text: "Good morning! Project status looks healthy today.",
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call?.params?.text).toBe("Good morning! Project status looks healthy today.");
  });

  it("does not affect outbound text when no boot prompt is registered for the session", async () => {
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const call = await executeSend({
      action: {
        target: "telegram:123",
        text: "Any message goes through unchanged.",
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });
    expect(call?.params?.text).toBe("Any message goes through unchanged.");
  });

  it("collapses presentation fields that echo a substantial chunk of the registered boot prompt (#53732)", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "slack", to: "slack:C123" });

    const echoedBootText =
      "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel";
    const call = await executeSend({
      action: {
        target: "slack:C123",
        mediaUrl: "file:///tmp/proof.png",
        presentation: {
          title: echoedBootText,
          blocks: [
            { type: "text", text: echoedBootText },
            {
              type: "buttons",
              buttons: [{ label: echoedBootText, value: "approve" }],
            },
            {
              type: "select",
              placeholder: echoedBootText,
              options: [{ label: echoedBootText, value: "main" }],
            },
          ],
        },
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });

    expect(call?.params?.presentation).toEqual({
      title: "",
      blocks: [
        { type: "text", text: "" },
        {
          type: "buttons",
          buttons: [{ label: "", value: "approve" }],
        },
        {
          type: "select",
          placeholder: "",
          options: [{ label: "", value: "main" }],
        },
      ],
    });
  });

  it("sanitizes boot echo text from presentation button links before dispatch", async () => {
    setBootEchoContextForSession("agent:main", longBootPrompt);
    mockSendResult({ channel: "slack", to: "slack:C123" });

    const echoedText =
      "When you wake up each morning, send a thoughtful greeting to the operator over the configured channel and report the active project status";
    const call = await executeSend({
      action: {
        target: "slack:C123",
        message: "Visible",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Status", url: echoedText },
                { label: "App", webApp: { url: echoedText }, web_app: { url: echoedText } },
              ],
            },
          ],
        },
      },
      toolOptions: { agentSessionKey: "agent:main" },
    });

    expect(call?.params?.message).toBe("Visible");
    expect(call?.params?.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Status" }, { label: "App" }],
        },
      ],
    });
  });
});

describe("message tool internal-runtime-context sanitization", () => {
  it.each([
    {
      field: "text",
      input:
        "Here is the boot info:\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nThis context is runtime-generated, not user-authored. Keep internal details private.\n\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nDone.",
      expected: "Here is the boot info:\n\nDone.",
      target: "signal:+15551234567",
      channel: "signal",
    },
    {
      field: "content",
      input:
        "Before\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nleaked\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nAfter",
      expected: "Before\n\nAfter",
      target: "discord:123",
      channel: "discord",
    },
    {
      field: "message",
      input:
        "Here is the boot info:\\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\\nBOOT.md:\\nWake up and report.\\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\\nDone.",
      expected: "Here is the boot info:\n\nDone.",
      target: "telegram:123",
      channel: "telegram",
    },
    {
      field: "SendMessage",
      input:
        "Alias\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nDone.",
      expected: "Alias\n\nDone.",
      target: "telegram:123",
      channel: "telegram",
    },
  ])(
    "strips internal-runtime-context blocks in $field before sending so verbatim boot-prompt echoes do not leak (#53732)",
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

  it("strips inbound metadata and delivery hints from outbound message text before dispatch (#89100)", async () => {
    mockSendResult({ channel: "signal", to: "signal:group-1" });

    const call = await executeSend({
      action: {
        target: "signal:group-1",
        message: [
          "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
          "",
          "Conversation info (untrusted metadata):",
          "```json",
          '{"chat_id":"group:abc","sender_id":"+15551234567","is_group_chat":true}',
          "```",
          "",
          "Sender (untrusted metadata):",
          "```json",
          '{"label":"Bob (+15551234567)","id":"+15551234567"}',
          "```",
          "",
          "Visible reply only.",
        ].join("\n"),
      },
    });

    expect(call?.params?.message).toBe("Visible reply only.");
    expect(JSON.stringify(call?.params)).not.toContain("sender_id");
    expect(JSON.stringify(call?.params)).not.toContain("+15551234567");
  });

  it.each([
    {
      name: "delivery hint only",
      message:
        "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
    },
    {
      name: "narration-aware delivery hint only",
      message: MESSAGE_TOOL_ONLY_DELIVERY_HINT,
    },
    {
      name: "room-event delivery hint only",
      message: ROOM_EVENT_DELIVERY_HINT,
    },
    {
      name: "inbound metadata only",
      message: [
        "Conversation info (untrusted metadata):",
        "```json",
        '{"chat_id":"group:abc","sender_id":"+15551234567"}',
        "```",
      ].join("\n"),
    },
  ])("suppresses outbound sends that contain only $name (#89100)", async ({ message }) => {
    const { call, result } = await executeSendWithResult({
      action: {
        target: "signal:group-1",
        message,
      },
    });

    expect(call).toBeUndefined();
    expect(mocks.runMessageAction).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "suppressed",
      reason: "inbound_metadata_echo",
    });
    expect(JSON.stringify(result)).not.toContain("sender_id");
    expect(JSON.stringify(result)).not.toContain("+15551234567");
  });

  it("preserves legitimate outbound messages that start with timestamp-like text", async () => {
    mockSendResult({ channel: "signal", to: "signal:group-1" });

    const message = "[Wed 2026-03-11 23:51 PDT] Standup starts now";
    const call = await executeSend({
      action: {
        target: "signal:group-1",
        message,
      },
    });

    expect(call?.params?.message).toBe(message);
  });

  it("strips internal-runtime-context blocks from poll creation text before dispatch", async () => {
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const internalContext =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const call = await executeSend({
      action: {
        action: "poll",
        target: "telegram:123",
        pollQuestion: `Choose one\n${internalContext}`,
        pollOption: [`Yes\n${internalContext}`, "No"],
      },
    });

    expect(call?.params?.pollQuestion).toBe("Choose one");
    expect(call?.params?.pollOption).toEqual(["Yes", "No"]);
  });

  it("strips internal-runtime-context blocks from quote text before dispatch", async () => {
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const internalContext =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const call = await executeSend({
      action: {
        target: "telegram:123",
        message: "Visible",
        quoteText: `Quoted\n${internalContext}`,
      },
    });

    expect(call?.params?.quoteText).toBe("Quoted");
  });

  it("parses and sanitizes stringified presentation and interactive payloads before dispatch", async () => {
    mockSendResult({ channel: "slack", to: "slack:C123" });

    const internalContext =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const call = await executeSend({
      action: {
        target: "slack:C123",
        message: "Visible",
        presentation: JSON.stringify({
          title: `Presentation\n${internalContext}`,
          blocks: [{ type: "text", text: `Block\n${internalContext}` }],
        }),
        interactive: JSON.stringify({
          blocks: [{ type: "text", text: `Legacy\n${internalContext}` }],
        }),
      },
    });

    expect(call?.params?.presentation).toEqual({
      title: "Presentation",
      blocks: [{ type: "text", text: "Block" }],
    });
    expect(call?.params?.interactive).toEqual({
      blocks: [{ type: "text", text: "Legacy" }],
    });
  });

  it("suppresses pure internal-runtime-context sends before generic raw-params logging can see original args", async () => {
    const { call, result } = await executeSendWithResult({
      action: {
        target: "discord:123",
        content:
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      },
    });

    expect(call).toBeUndefined();
    expect(mocks.runMessageAction).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "suppressed",
      reason: "internal_runtime_context_echo",
    });
    expect(JSON.stringify(result)).not.toContain("BOOT.md");
    expect(JSON.stringify(result)).not.toContain("Wake up and report");
  });

  it("sanitizes every visible text alias even after an earlier field is fully suppressed", async () => {
    mockSendResult({ channel: "telegram", to: "telegram:123" });

    const internalOnly =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nBOOT.md:\nWake up and report.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const call = await executeSend({
      action: {
        target: "telegram:123",
        text: internalOnly,
        message: `Visible\n${internalOnly}`,
        mediaUrl: "file:///tmp/status.png",
      },
    });

    expect(call?.params?.text).toBe("");
    expect(call?.params?.message).toBe("Visible");
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
});
