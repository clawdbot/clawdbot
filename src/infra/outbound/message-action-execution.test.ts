// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { runMessageAction } from "./message-action-runner.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

const requireRecord = createRequireRecord("record", "expected-non-array-record");
const requireLabeledRecord = createRequireRecord("record", "expected-label");

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readPluginCall(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readLastPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return readPluginCall(mock, mock.mock.calls.length - 1);
}

function readMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const mockCall = mock.mock.calls[callIndex];
  const value = mockCall?.[argIndex];
  return requireLabeledRecord(value, label);
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  return requireLabeledRecord(value, label);
}

function expectRecordFields(
  record: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(value);
  }
}

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
  hasCorePresentationDelivery: vi.fn(),
  materializeMessagePresentationFallback: vi.fn(),
  callGateway: vi.fn(),
  callGatewayLeastPrivilege: vi.fn(),
  isGatewayTransportError: vi.fn(),
  randomIdempotencyKey: vi.fn(() => "idem-gateway-action"),
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
  prepareOutboundMirrorRoute: vi.fn(),
  beginTerminalSourceReplyDelivery: vi.fn(),
  cancelTerminalSourceReplyDelivery: vi.fn(),
  isCurrentSourceReplyActionName: vi.fn(() => false),
  isDeliveredCurrentSourceReply: vi.fn(() => false),
  isDeliveredCurrentSourceReplyAction: vi.fn(() => false),
  reconcileTerminalSourceReplyDelivery: vi.fn(),
}));

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined,
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
  resetOutboundChannelResolutionStateForTest: vi.fn(),
}));

vi.mock("./outbound-send-service.js", () => ({
  executeSendAction: mocks.executeSendAction,
  executePollAction: mocks.executePollAction,
  hasCorePresentationDelivery: mocks.hasCorePresentationDelivery,
  materializeMessagePresentationFallback: mocks.materializeMessagePresentationFallback,
}));

vi.mock("./message.gateway.runtime.js", () => ({
  callGateway: mocks.callGateway,
  callGatewayLeastPrivilege: mocks.callGatewayLeastPrivilege,
  isGatewayTransportError: mocks.isGatewayTransportError,
  randomIdempotencyKey: mocks.randomIdempotencyKey,
}));

vi.mock("./source-reply-mirror.js", () => ({
  beginTerminalSourceReplyDelivery: mocks.beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery: mocks.cancelTerminalSourceReplyDelivery,
  isCurrentSourceReplyActionName: mocks.isCurrentSourceReplyActionName,
  isDeliveredCurrentSourceReply: mocks.isDeliveredCurrentSourceReply,
  isDeliveredCurrentSourceReplyAction: mocks.isDeliveredCurrentSourceReplyAction,
  reconcileTerminalSourceReplyDelivery: mocks.reconcileTerminalSourceReplyDelivery,
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: mocks.maybeApplyTtsToPayload,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "actionhub"
      ? {
          actions: {
            messageActionTargetAliases: {
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
              "list-pins": { aliases: ["chatId"] },
            },
          },
        }
      : undefined,
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  const threading = createOutboundThreadingMock();
  mocks.prepareOutboundMirrorRoute.mockImplementation(threading.prepareOutboundMirrorRoute);
  return {
    ...threading,
    prepareOutboundMirrorRoute: mocks.prepareOutboundMirrorRoute,
  };
});

function setTestPlugin(plugin: unknown, pluginId: string, origin?: "bundled") {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId, source: "test", ...(origin ? { origin } : {}), plugin }]),
  );
}

function createAlwaysConfiguredPluginConfig(account: Record<string, unknown> = { enabled: true }) {
  return {
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
    isConfigured: () => true,
  };
}

function createPollForwardingPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  return {
    id: params.pluginId,
    meta: {
      id: params.pluginId,
      label: params.label,
      selectionLabel: params.label,
      docsPath: `/channels/${params.pluginId}`,
      blurb: params.blurb,
    },
    capabilities: { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      supportsAction: ({ action }) => action === "poll",
      handleAction: params.handleAction,
    },
  };
}

function createGatewayActionPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  actions: ChannelMessageActionName[];
  gatewayActions?: ChannelMessageActionName[];
  capabilities?: ChannelPlugin["capabilities"];
  messaging?: ChannelPlugin["messaging"];
  threading?: ChannelPlugin["threading"];
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  const actions = new Set(params.actions);
  const gatewayActions = new Set(params.gatewayActions ?? params.actions);
  return {
    id: params.pluginId,
    meta: {
      id: params.pluginId,
      label: params.label,
      selectionLabel: params.label,
      docsPath: `/channels/${params.pluginId}`,
      blurb: params.blurb,
    },
    capabilities: params.capabilities ?? { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    messaging: params.messaging,
    threading: params.threading,
    actions: {
      describeMessageTool: () => ({ actions: params.actions }),
      supportsAction: ({ action }) => actions.has(action),
      resolveExecutionMode: ({ action }) => (gatewayActions.has(action) ? "gateway" : "local"),
      handleAction: params.handleAction,
    },
  };
}

async function executePluginAction(params: {
  action: "send" | "poll";
  ctx: Pick<
    ChannelMessageActionContext,
    | "channel"
    | "cfg"
    | "params"
    | "mediaAccess"
    | "accountId"
    | "gateway"
    | "toolContext"
    | "inboundEventKind"
  > & {
    dryRun: boolean;
    agentId?: string;
  };
}) {
  const handled = await dispatchChannelMessageAction({
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    mediaAccess: params.ctx.mediaAccess,
    mediaLocalRoots: params.ctx.mediaAccess?.localRoots ?? [],
    mediaReadFile:
      typeof params.ctx.mediaAccess?.readFile === "function"
        ? params.ctx.mediaAccess.readFile
        : undefined,
    accountId: params.ctx.accountId ?? undefined,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.toolContext,
    inboundEventKind: params.ctx.inboundEventKind,
    dryRun: params.ctx.dryRun,
    agentId: params.ctx.agentId,
  });
  if (!handled) {
    throw new Error(`expected plugin to handle ${params.action}`);
  }
  return {
    handledBy: "plugin" as const,
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

describe("runMessageAction plugin dispatch", () => {
  beforeEach(() => {
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(
      ({ channel }: { channel: string }) =>
        getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
    );
    mocks.executeSendAction.mockReset();
    mocks.executeSendAction.mockImplementation(
      async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
        await executePluginAction({ action: "send", ctx }),
    );
    mocks.executePollAction.mockReset();
    mocks.executePollAction.mockImplementation(
      async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
        await executePluginAction({ action: "poll", ctx }),
    );
    mocks.hasCorePresentationDelivery.mockReset();
    mocks.hasCorePresentationDelivery.mockImplementation(
      (outbound?: { sendPayload?: unknown; sendText?: unknown; sendFormattedText?: unknown }) =>
        Boolean(outbound?.sendPayload || outbound?.sendText || outbound?.sendFormattedText),
    );
    mocks.materializeMessagePresentationFallback.mockReset();
    mocks.materializeMessagePresentationFallback.mockImplementation(
      (params: { payload: { presentation?: unknown; text?: string }; text?: string }) => {
        const presentation = normalizeMessagePresentation(params.payload.presentation);
        const text = (params.text ?? params.payload.text ?? "").trim();
        if (!presentation) {
          return text;
        }
        const fallback = renderMessagePresentationFallbackText({ presentation });
        return !fallback || text.includes(fallback)
          ? text
          : [text, fallback].filter(Boolean).join("\n\n");
      },
    );
    mocks.callGateway.mockReset();
    mocks.callGatewayLeastPrivilege.mockReset();
    mocks.isGatewayTransportError.mockReset();
    mocks.isGatewayTransportError.mockImplementation(
      (value: unknown) =>
        value instanceof Error && (value as { kind?: unknown }).kind === "timeout",
    );
    mocks.randomIdempotencyKey.mockClear();
    mocks.maybeApplyTtsToPayload.mockReset();
    mocks.maybeApplyTtsToPayload.mockImplementation(
      async (params: { payload: unknown }) => params.payload,
    );
    mocks.prepareOutboundMirrorRoute.mockClear();
    mocks.beginTerminalSourceReplyDelivery.mockReset();
    mocks.cancelTerminalSourceReplyDelivery.mockReset();
    mocks.reconcileTerminalSourceReplyDelivery.mockReset();
  });
  describe("alias-based plugin action dispatch", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        params,
      }),
    );

    const actionHubPlugin: ChannelPlugin = {
      id: "actionhub",
      meta: {
        id: "actionhub",
        label: "Action Hub",
        selectionLabel: "Action Hub",
        docsPath: "/channels/actionhub",
        blurb: "Action Hub action dispatch test plugin.",
      },
      capabilities: { chatTypes: ["direct", "channel"] },
      config: createAlwaysConfiguredPluginConfig(),
      messaging: {
        targetPrefixes: ["actionhub", "actionhub-alias"],
        normalizeTarget: (raw) => raw.replace(/^actionhub-alias:/i, "actionhub:"),
        targetResolver: {
          looksLikeId: () => true,
        },
      },
      actions: {
        describeMessageTool: () => ({
          actions: [
            "pin",
            "unpin",
            "list-pins",
            "member-info",
            "channel-info",
            "edit",
            "thread-create",
            "thread-reply",
          ],
        }),
        messageActionTargetAliases: {
          edit: {
            aliases: ["messageId", "chatId", "chat_id", "channel_id"],
            deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
          },
          pin: {
            aliases: ["messageId", "chatId", "chat_id", "channel_id"],
            deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
          },
          unpin: {
            aliases: ["messageId", "chatId", "chat_id", "channel_id"],
            deliveryTargetAliases: ["chatId", "chat_id", "channel_id"],
          },
        },
        supportsAction: ({ action }) =>
          action === "pin" ||
          action === "unpin" ||
          action === "list-pins" ||
          action === "member-info" ||
          action === "channel-info" ||
          action === "edit" ||
          action === "thread-create" ||
          action === "thread-reply",
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(actionHubPlugin, "actionhub");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });
    it("dispatches messageId/chatId-based plugin actions through the shared runner", async () => {
      const resolveAgentRuntimeIdentityToken = vi.fn(async () => "unused-agent-runtime-token");
      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "pin",
        params: {
          channel: "actionhub",
          messageId: "om_123",
        },
        gateway: {
          resolveAgentRuntimeIdentityToken,
          clientName: "gateway-client",
          mode: "backend",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      await runMessageAction({
        cfg: {
          channels: {
            actionhub: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "list-pins",
        params: {
          channel: "actionhub",
          chatId: "oc_123",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      const pinCall = readPluginCall(handleAction, 0);
      expectRecordFields(
        pinCall,
        { action: "pin", conversationReadOrigin: "direct-operator" },
        "pin call",
      );
      expectRecordFields(
        readRecordField(pinCall, "params", "pin call params"),
        { messageId: "om_123" },
        "pin call params",
      );
      const listPinsCall = readPluginCall(handleAction, 1);
      expectRecordFields(listPinsCall, { action: "list-pins" }, "list pins call");
      expectRecordFields(
        readRecordField(listPinsCall, "params", "list pins call params"),
        { chatId: "oc_123" },
        "list pins call params",
      );
      expect(resolveAgentRuntimeIdentityToken).not.toHaveBeenCalled();
    });

    it("preserves canonical thread and edit fields through plugin dispatch", async () => {
      const cfg = {
        channels: {
          actionhub: {
            enabled: true,
          },
        },
      } as OpenClawConfig;

      await runMessageAction({
        cfg,
        action: "thread-create",
        params: {
          channel: "actionhub",
          target: "actionhub:room",
          threadName: "Canonical thread",
        },
        dryRun: false,
      });
      await runMessageAction({
        cfg,
        action: "thread-reply",
        params: {
          channel: "actionhub",
          target: "actionhub:room/thread-1",
          message: "Canonical reply",
        },
        dryRun: false,
      });
      await runMessageAction({
        cfg,
        action: "edit",
        params: {
          channel: "actionhub",
          target: "actionhub:room/thread-1",
          messageId: "om_123",
          message: "Canonical edit",
        },
        conversationReadOrigin: "direct-operator",
        dryRun: false,
      });

      expectRecordFields(
        readRecordField(readPluginCall(handleAction, 0), "params", "thread-create params"),
        {
          target: "actionhub:room",
          to: "actionhub:room",
          threadName: "Canonical thread",
        },
        "thread-create params",
      );
      expectRecordFields(
        readRecordField(readPluginCall(handleAction, 1), "params", "thread-reply params"),
        {
          target: "actionhub:room/thread-1",
          to: "actionhub:room/thread-1",
          message: "Canonical reply",
        },
        "thread-reply params",
      );
      expectRecordFields(
        readRecordField(readPluginCall(handleAction, 2), "params", "edit params"),
        {
          target: "actionhub:room/thread-1",
          to: "actionhub:room/thread-1",
          messageId: "om_123",
          message: "Canonical edit",
        },
        "edit params",
      );
    });

    it("routes execution context ids into plugin handleAction", async () => {
      const stateDir = path.join("/tmp", "openclaw-plugin-dispatch-media-roots");
      const expectedWorkspaceRoot = path.resolve(stateDir, "workspace-alpha");

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await runMessageAction({
          cfg: {
            channels: {
              actionhub: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "pin",
          params: {
            channel: "actionhub",
            messageId: "om_123",
          },
          defaultAccountId: "ops",
          requesterAccountId: "ops",
          requesterSenderId: "trusted-user",
          conversationReadOrigin: "direct-operator",
          sessionKey: "agent:alpha:main",
          sessionId: "session-123",
          agentId: "alpha",
          inboundEventKind: "room_event",
          toolContext: {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          dryRun: false,
        });

        const call = readLastPluginCall(handleAction);
        expectRecordFields(
          call,
          {
            action: "pin",
            accountId: "ops",
            requesterAccountId: "ops",
            requesterSenderId: "trusted-user",
            conversationReadOrigin: "direct-operator",
            sessionKey: "agent:alpha:main",
            sessionId: "session-123",
            inboundEventKind: "room_event",
            agentId: "alpha",
          },
          "plugin action call",
        );
        expect(Array.isArray(call.mediaLocalRoots)).toBe(true);
        expect((call.mediaLocalRoots as unknown[]).includes(expectedWorkspaceRoot)).toBe(true);
        expectRecordFields(
          readRecordField(call, "toolContext", "plugin tool context"),
          {
            currentChannelId: "oc_123",
            currentChannelProvider: "actionhub",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          },
          "plugin tool context",
        );
      });
    });
  });
  describe("threaded plugin actions", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({ ok: true, params }),
    );
    const cfg = { channels: { forumchat: { enabled: true } } } as OpenClawConfig;
    const threading: ChannelPlugin["threading"] = {
      resolveAutoThreadId: ({ toolContext, to }) =>
        toolContext?.currentChannelId === to ? toolContext.currentThreadTs : undefined,
    };
    const createThreadedPlugin = (executionMode: "local" | "gateway") =>
      createGatewayActionPlugin({
        pluginId: "forumchat",
        label: "Forum Chat",
        blurb: "Forum chat threaded action dispatch test plugin.",
        actions: ["sticker"],
        gatewayActions: executionMode === "gateway" ? ["sticker"] : [],
        capabilities: { chatTypes: ["channel"] },
        threading,
        handleAction,
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
      });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it.each(["local", "gateway"] as const)(
      "applies auto threadId before %s plugin dispatch",
      async (executionMode) => {
        setTestPlugin(createThreadedPlugin(executionMode), "forumchat");
        mocks.callGatewayLeastPrivilege.mockResolvedValue({ ok: true });

        await runMessageAction({
          cfg,
          action: "sticker",
          params: {
            channel: "forumchat",
            target: "forum:123",
            stickerName: "wave",
          },
          toolContext: {
            currentChannelProvider: "forumchat",
            currentChannelId: "forum:123",
            currentThreadTs: "42",
          },
          gateway: executionMode === "gateway" ? { clientName: "cli", mode: "cli" } : undefined,
          dryRun: false,
        });

        const dispatchedParams =
          executionMode === "gateway"
            ? readRecordField(
                readRecordField(
                  readMockCallArg(mocks.callGatewayLeastPrivilege, "gateway call"),
                  "params",
                  "gateway call params",
                ),
                "params",
                "gateway action params",
              )
            : readRecordField(readFirstPluginCall(handleAction), "params", "plugin params");
        expectRecordFields(
          dispatchedParams,
          { to: "forum:123", threadId: "42" },
          `${executionMode} action params`,
        );
        expect(handleAction).toHaveBeenCalledTimes(executionMode === "local" ? 1 : 0);
      },
    );
  });
  describe("poll plugin forwarding", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        forwarded: {
          to: params.to ?? null,
          pollQuestion: params.pollQuestion ?? null,
          pollOption: params.pollOption ?? null,
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollPublic: params.pollPublic ?? null,
          threadId: params.threadId ?? null,
        },
      }),
    );

    const pollChatPlugin = createPollForwardingPlugin({
      pluginId: "pollchat",
      label: "Poll Chat",
      blurb: "Poll chat forwarding test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setTestPlugin(pollChatPlugin, "pollchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it("forwards poll params through plugin dispatch", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            pollchat: {
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "pollchat",
          target: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        dryRun: false,
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      const pluginCall = readFirstPluginCall(handleAction);
      expectRecordFields(
        pluginCall,
        {
          action: "poll",
          channel: "pollchat",
        },
        "plugin call",
      );
      expectRecordFields(
        readRecordField(pluginCall, "params", "plugin params"),
        {
          to: "pollchat:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
        "plugin params",
      );
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          forwarded: {
            to: "pollchat:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationSeconds: 120,
            pollPublic: true,
            threadId: "42",
          },
        },
        "result payload",
      );
    });
  });
  describe("plugin-owned poll semantics", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        forwarded: {
          to: params.to ?? null,
          pollQuestion: params.pollQuestion ?? null,
          pollOption: params.pollOption ?? null,
          pollDurationSeconds: params.pollDurationSeconds ?? null,
          pollPublic: params.pollPublic ?? null,
        },
      }),
    );

    const guildPollPlugin = createPollForwardingPlugin({
      pluginId: "guildchat",
      label: "Guild Chat",
      blurb: "Guild chat plugin-owned poll test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setTestPlugin(guildPollPlugin, "guildchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("lets other plugins own extra poll fields", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            guildchat: {
              token: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "guildchat",
          target: "channel:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
        },
        dryRun: false,
      });

      expect(result.kind).toBe("poll");
      expect(result.handledBy).toBe("plugin");
      const pluginCall = readFirstPluginCall(handleAction);
      expectRecordFields(
        pluginCall,
        {
          action: "poll",
          channel: "guildchat",
        },
        "plugin call",
      );
      expectRecordFields(
        readRecordField(pluginCall, "params", "plugin params"),
        {
          to: "channel:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
        },
        "plugin params",
      );
    });
  });
});
