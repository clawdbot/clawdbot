// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
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
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { runMessageAction } from "./message-action-runner.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

const requireLabeledRecord = createRequireRecord("record", "expected-label");

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
    it("rejects unsupported read actions before conversation authorization", async () => {
      await expect(
        runMessageAction({
          cfg: {
            channels: {
              actionhub: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "react",
          params: {
            channel: "actionhub",
            target: "other-conversation",
            messageId: "om_123",
            emoji: "eyes",
          },
          conversationReadOrigin: "delegated",
          dryRun: false,
        }),
      ).rejects.toThrow("Message action react not supported for channel actionhub.");
      expect(handleAction).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "rejects an external exact-current alias with the wrong account before target resolution (dryRun=%s)",
      async (dryRun) => {
        const looksLikeId = vi.fn(() => true);
        setActivePluginRegistry(
          createTestRegistry([
            {
              pluginId: "actionhub",
              source: "test",
              origin: "config",
              plugin: {
                ...actionHubPlugin,
                messaging: {
                  ...actionHubPlugin.messaging,
                  targetResolver: {
                    looksLikeId,
                  },
                },
              },
            },
          ]),
        );

        await expect(
          runMessageAction({
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
              target: "room:current",
              messageId: "om_123",
            },
            defaultAccountId: "other",
            requesterAccountId: "default",
            conversationReadOrigin: "delegated",
            toolContext: {
              currentChannelId: "actionhub:current",
              currentChannelProvider: "actionhub",
              currentChatType: "group",
            },
            dryRun,
          }),
        ).rejects.toThrow("requires the exact current conversation and account");
        expect(looksLikeId).not.toHaveBeenCalled();
        expect(handleAction).not.toHaveBeenCalled();
      },
    );

    it("rejects directory-only external aliases before resolver or plugin code", async () => {
      const looksLikeId = vi.fn(() => false);
      const resolveTarget = vi.fn(async () => ({
        to: "actionhub:current",
        kind: "group" as const,
      }));
      const listGroups = vi.fn(async () => [
        { kind: "group" as const, id: "actionhub:current", name: "current-room" },
      ]);
      const listGroupsLive = vi.fn(async () => [
        { kind: "group" as const, id: "actionhub:current", name: "current-room" },
      ]);
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "actionhub",
            source: "test",
            origin: "config",
            plugin: {
              ...actionHubPlugin,
              messaging: {
                ...actionHubPlugin.messaging,
                targetResolver: { looksLikeId, resolveTarget },
              },
              directory: { listGroups, listGroupsLive },
            },
          },
        ]),
      );

      await expect(
        runMessageAction({
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
            target: "current-room",
            messageId: "om_123",
          },
          defaultAccountId: "default",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelId: "actionhub:current",
            currentChannelProvider: "actionhub",
            currentChatType: "group",
          },
          dryRun: false,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");

      expect(looksLikeId).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(listGroups).not.toHaveBeenCalled();
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("rejects unauthorized gateway-mode dry runs without resolving a target", async () => {
      const looksLikeId = vi.fn(() => true);
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat dry-run authorization test plugin.",
        actions: ["react"],
        capabilities: { chatTypes: ["direct"], reactions: true },
        messaging: {
          targetResolver: {
            looksLikeId,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true, local: true })),
      });
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "gatewaychat",
            source: "test",
            origin: "config",
            plugin: gatewayPlugin,
          },
        ]),
      );

      await expect(
        runMessageAction({
          cfg: {
            channels: {
              gatewaychat: {
                enabled: true,
              },
            },
          } as OpenClawConfig,
          action: "react",
          params: {
            channel: "gatewaychat",
            target: "room:current",
            messageId: "message-1",
            emoji: "eyes",
          },
          defaultAccountId: "other",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelId: "gatewaychat:current",
            currentChannelProvider: "gatewaychat",
            currentChatType: "group",
          },
          gateway: {
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          dryRun: true,
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(looksLikeId).not.toHaveBeenCalled();
      expect(mocks.callGatewayLeastPrivilege).not.toHaveBeenCalled();
    });

    it("preserves gateway send receipts in broadcast results", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        messageId: "gw-broadcast-1",
      });

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: true,
              payload: {
                ok: true,
                messageId: "gw-broadcast-1",
              },
            },
          ],
        },
      });
      expect(mocks.executeSendAction).not.toHaveBeenCalled();
    });

    it("preserves partial-delivery evidence from failed broadcast sends", async () => {
      const gatewayPlugin = createGatewayActionPlugin({
        pluginId: "gatewaychat",
        label: "Gateway Chat",
        blurb: "Gateway Chat partial broadcast test plugin.",
        actions: ["send"],
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        handleAction: vi.fn(async () => jsonResult({ ok: true })),
      });
      setTestPlugin(gatewayPlugin, "gatewaychat");
      mocks.callGatewayLeastPrivilege.mockRejectedValue(
        Object.assign(new Error("second payload failed"), { sentBeforeError: true }),
      );

      const result = await runMessageAction({
        cfg: {
          channels: {
            gatewaychat: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "gatewaychat",
          targets: ["user-123"],
          message: "hello from broadcast",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "gatewaychat",
              to: "user-123",
              ok: false,
              sentBeforeError: true,
              error: "second payload failed",
            },
          ],
        },
      });
    });
  });
  describe("presentation parsing", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        presentation: params.presentation ?? null,
      }),
    );

    const componentsPlugin: ChannelPlugin = {
      id: "componentchat",
      meta: {
        id: "componentchat",
        label: "Component Chat",
        selectionLabel: "Component Chat",
        docsPath: "/channels/componentchat",
        blurb: "Component chat send test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig({}),
      actions: {
        describeMessageTool: () => ({ actions: ["send"], capabilities: ["presentation"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(componentsPlugin, "componentchat");
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("parses presentation JSON strings before plugin dispatch", async () => {
      const presentation = {
        blocks: [{ type: "buttons", buttons: [{ label: "A", value: "a" }] }],
      };
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "componentchat",
          target: "channel:123",
          message: "hi",
          presentation: JSON.stringify(presentation),
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(handleAction).toHaveBeenCalled();
      expectRecordFields(
        readRecordField(result, "payload", "result payload"),
        {
          ok: true,
          presentation,
        },
        "result payload",
      );
    });

    it("throws on invalid presentation JSON strings", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          params: {
            channel: "componentchat",
            target: "channel:123",
            message: "hi",
            presentation: "{not-json}",
          },
          dryRun: false,
        }),
      ).rejects.toThrow(/--presentation must be valid JSON/);

      expect(handleAction).not.toHaveBeenCalled();
    });
  });
  describe("accountId defaults", () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const listGroupsLive = vi.fn(async () => [
      { id: "channel:resolved", name: "resolved", kind: "group" as const },
    ]);
    const accountPlugin: ChannelPlugin = {
      id: "accountchat",
      meta: {
        id: "accountchat",
        label: "Account Chat",
        selectionLabel: "Account Chat",
        docsPath: "/channels/accountchat",
        blurb: "Account chat test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default", "ops", "disabled"],
        resolveAccount: (_cfg, accountId) => ({ enabled: accountId !== "disabled" }),
      },
      directory: { listGroupsLive },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
      },
    };

    beforeEach(() => {
      setTestPlugin(accountPlugin, "accountchat");
      handleAction.mockClear();
      listGroupsLive.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });
    it("rejects an unknown broadcast account before live target resolution", async () => {
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "broadcast",
        params: {
          channel: "accountchat",
          targets: ["resolved"],
          accountId: "missing",
          message: "hi",
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [{ ok: false, error: expect.stringContaining("Unknown account") }],
        },
      });
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("preserves planned per-channel broadcast rejection without resolving a target", async () => {
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "broadcast",
        params: {
          targets: ["resolved"],
          accountId: "missing",
          message: "hi",
        },
        broadcastAccountPlan: {
          accountId: "missing",
          candidateChannels: ["accountchat"],
          secretChannels: [],
        },
      });

      expect(result).toMatchObject({
        kind: "broadcast",
        payload: {
          results: [
            {
              channel: "accountchat",
              ok: false,
              error: expect.stringContaining("Unknown account"),
            },
          ],
        },
      });
      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });

    it("rejects an empty broadcast account plan instead of reporting empty success", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "broadcast",
          params: {
            targets: ["resolved"],
            accountId: "missing",
            message: "hi",
          },
          broadcastAccountPlan: {
            accountId: "missing",
            candidateChannels: [],
            secretChannels: [],
          },
        }),
      ).rejects.toThrow("Broadcast requires at least one configured channel");

      expect(listGroupsLive).not.toHaveBeenCalled();
      expect(handleAction).not.toHaveBeenCalled();
    });
  });
});
