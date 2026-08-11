// Covers plugin-dispatched message actions, target resolution, dry-run behavior,
// and plugin tool-result extraction.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
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
import { runMessageAction } from "./message-action-runner.js";

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function readFirstPluginCall(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [mockCall] = mock.mock.calls;
  const call = mockCall?.[0];
  return requireRecord(call);
}

function readMediaAccess(call: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(call.mediaAccess);
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
    it("uses requester session channel policy for host-media reads", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policydest",
        meta: {
          id: "policydest",
          label: "Policy Destination",
          selectionLabel: "Policy Destination",
          docsPath: "/channels/policydest",
          blurb: "Policy destination test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setTestPlugin(policyPlugin, "policydest");

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              groups: {
                ops: {
                  toolsBySender: {
                    "id:trusted-user": {
                      deny: ["read"],
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const mediaAccess = readMediaAccess(readFirstPluginCall(handlePolicyCheckedAction));
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("uses requester username policy for host-media reads", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policydest",
        meta: {
          id: "policydest",
          label: "Policy Destination",
          selectionLabel: "Policy Destination",
          docsPath: "/channels/policydest",
          blurb: "Policy destination username test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: createAlwaysConfiguredPluginConfig(),
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setTestPlugin(policyPlugin, "policydest");

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              groups: {
                ops: {
                  toolsBySender: {
                    "username:alice_u": {
                      deny: ["read"],
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderUsername: "alice_u",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const mediaAccess = readMediaAccess(readFirstPluginCall(handlePolicyCheckedAction));
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("uses requester account policy for host-media reads when destination account differs", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policydest",
        meta: {
          id: "policydest",
          label: "Policy Destination",
          selectionLabel: "Policy Destination",
          docsPath: "/channels/policydest",
          blurb: "Policy destination account test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: {
          ...createAlwaysConfiguredPluginConfig(),
          listAccountIds: () => ["destination"],
        },
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setTestPlugin(policyPlugin, "policydest");

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policydest: {
              enabled: true,
            },
            requestchat: {
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
                destination: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          allow: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policydest",
          accountId: "destination",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterAccountId: "source",
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:requestchat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("destination");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });

    it("falls back to the resolved account policy when requester account is unavailable", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "policychat",
        meta: {
          id: "policychat",
          label: "Policy Chat",
          selectionLabel: "Policy Chat",
          docsPath: "/channels/policychat",
          blurb: "Policy chat account fallback test plugin.",
        },
        capabilities: { chatTypes: ["direct", "channel"], media: true },
        config: {
          ...createAlwaysConfiguredPluginConfig(),
          listAccountIds: () => ["source"],
        },
        messaging: {
          targetResolver: {
            looksLikeId: () => true,
          },
        },
        actions: {
          describeMessageTool: () => ({ actions: ["send"] }),
          supportsAction: ({ action }) => action === "send",
          handleAction: handlePolicyCheckedAction,
        },
      };

      setTestPlugin(policyPlugin, "policychat");

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            policychat: {
              enabled: true,
              accounts: {
                source: {
                  groups: {
                    ops: {
                      toolsBySender: {
                        "id:trusted-user": {
                          deny: ["read"],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "policychat",
          accountId: "source",
          target: "group:ops",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:policychat:group:ops",
        dryRun: false,
      });

      const pluginCall = readFirstPluginCall(handlePolicyCheckedAction);
      expect(pluginCall.accountId).toBe("source");
      const mediaAccess = readMediaAccess(pluginCall);
      expect(mediaAccess.readFile).toBeUndefined();
    });
  });
});
