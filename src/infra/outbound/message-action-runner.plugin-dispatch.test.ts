import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import { extractToolPayload } from "./tool-payload.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

const mocks = vi.hoisted(() => ({
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
  callGatewayLeastPrivilege: vi.fn(),
  randomIdempotencyKey: vi.fn(() => "idem-gateway-action"),
}));

vi.mock("./channel-resolution.js", () => ({
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
  resetOutboundChannelResolutionStateForTest: vi.fn(),
}));

vi.mock("./outbound-send-service.js", () => ({
  executeSendAction: mocks.executeSendAction,
  executePollAction: mocks.executePollAction,
}));

vi.mock("./message.gateway.runtime.js", () => ({
  callGatewayLeastPrivilege: mocks.callGatewayLeastPrivilege,
  randomIdempotencyKey: mocks.randomIdempotencyKey,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "feishu"
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
  return createOutboundThreadingMock();
});

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

async function executePluginAction(params: {
  action: "send" | "poll";
  ctx: Pick<
    ChannelMessageActionContext,
    "channel" | "cfg" | "params" | "mediaAccess" | "accountId" | "gateway" | "toolContext"
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
    mocks.callGatewayLeastPrivilege.mockReset();
    mocks.randomIdempotencyKey.mockClear();
  });

  describe("alias-based plugin action dispatch", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        params,
      }),
    );

    const feishuLikePlugin: ChannelPlugin = {
      id: "feishu",
      meta: {
        id: "feishu",
        label: "Feishu",
        selectionLabel: "Feishu",
        docsPath: "/channels/feishu",
        blurb: "Feishu action dispatch test plugin.",
      },
      capabilities: { chatTypes: ["direct", "channel"] },
      config: createAlwaysConfiguredPluginConfig(),
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
        },
      },
      actions: {
        describeMessageTool: () => ({ actions: ["pin", "list-pins", "member-info"] }),
        supportsAction: ({ action }) =>
          action === "pin" || action === "list-pins" || action === "member-info",
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "feishu",
            source: "test",
            plugin: feishuLikePlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    it("dispatches messageId/chatId-based Feishu actions through the shared runner", async () => {
      await runMessageAction({
        cfg: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "pin",
        params: {
          channel: "feishu",
          messageId: "om_123",
        },
        dryRun: false,
      });

      await runMessageAction({
        cfg: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "list-pins",
        params: {
          channel: "feishu",
          chatId: "oc_123",
        },
        dryRun: false,
      });

      expect(handleAction).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          action: "pin",
          params: expect.objectContaining({
            messageId: "om_123",
          }),
        }),
      );
      expect(handleAction).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: "list-pins",
          params: expect.objectContaining({
            chatId: "oc_123",
          }),
        }),
      );
    });

    it("routes execution context ids into plugin handleAction", async () => {
      const stateDir = path.join("/tmp", "openclaw-plugin-dispatch-media-roots");
      const expectedWorkspaceRoot = path.resolve(stateDir, "workspace-alpha");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

      await runMessageAction({
        cfg: {
          channels: {
            feishu: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "pin",
        params: {
          channel: "feishu",
          messageId: "om_123",
        },
        defaultAccountId: "ops",
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:main",
        sessionId: "session-123",
        agentId: "alpha",
        toolContext: {
          currentChannelId: "oc_123",
          currentChannelProvider: "feishu",
          currentThreadTs: "thread-456",
          currentMessageId: "msg-789",
        },
        dryRun: false,
      });

      expect(handleAction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: "pin",
          accountId: "ops",
          requesterSenderId: "trusted-user",
          sessionKey: "agent:alpha:main",
          sessionId: "session-123",
          agentId: "alpha",
          mediaLocalRoots: expect.arrayContaining([expectedWorkspaceRoot]),
          toolContext: expect.objectContaining({
            currentChannelId: "oc_123",
            currentChannelProvider: "feishu",
            currentThreadTs: "thread-456",
            currentMessageId: "msg-789",
          }),
        }),
      );
    });

    it("routes gateway-executed plugin actions through gateway RPC instead of local dispatch", async () => {
      const handleAction = vi.fn(async () =>
        jsonResult({
          ok: true,
          local: true,
        }),
      );
      const gatewayPlugin: ChannelPlugin = {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "WhatsApp reaction test plugin.",
        },
        capabilities: { chatTypes: ["direct"], reactions: true },
        config: createAlwaysConfiguredPluginConfig(),
        actions: {
          describeMessageTool: () => ({ actions: ["react"] }),
          supportsAction: ({ action }) => action === "react",
          resolveExecutionMode: ({ action }) => (action === "react" ? "gateway" : "local"),
          handleAction,
        },
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test",
            plugin: gatewayPlugin,
          },
        ]),
      );
      mocks.callGatewayLeastPrivilege.mockResolvedValue({
        ok: true,
        added: "✅",
      });

      const result = await runMessageAction({
        cfg: {
          channels: {
            whatsapp: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        action: "react",
        params: {
          channel: "whatsapp",
          to: "+15551234567",
          chatJid: "+15551234567",
          messageId: "wamid.1",
          emoji: "✅",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:main",
        sessionId: "session-123",
        agentId: "alpha",
        toolContext: {
          currentChannelProvider: "whatsapp",
          currentMessageId: "wamid.1",
        },
        gateway: {
          clientName: "cli",
          mode: "cli",
        },
        dryRun: false,
      });

      expect(mocks.callGatewayLeastPrivilege).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "message.action",
          params: expect.objectContaining({
            channel: "whatsapp",
            action: "react",
            requesterSenderId: "trusted-user",
            sessionKey: "agent:alpha:main",
            sessionId: "session-123",
            agentId: "alpha",
            toolContext: expect.objectContaining({
              currentChannelProvider: "whatsapp",
              currentMessageId: "wamid.1",
            }),
            idempotencyKey: "idem-gateway-action",
          }),
        }),
      );
      expect(handleAction).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        kind: "action",
        channel: "whatsapp",
        action: "react",
        handledBy: "plugin",
        payload: {
          ok: true,
          added: "✅",
        },
      });
    });

    it("uses requester session channel policy for host-media reads", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "feishu",
        meta: {
          id: "feishu",
          label: "Feishu",
          selectionLabel: "Feishu",
          docsPath: "/channels/feishu",
          blurb: "Feishu policy test plugin.",
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

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "feishu",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            feishu: {
              enabled: true,
            },
            whatsapp: {
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
          channel: "feishu",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:whatsapp:group:ops",
        dryRun: false,
      });

      const pluginCall = handlePolicyCheckedAction.mock.calls[0]?.[0];
      expect(pluginCall?.mediaAccess).toBeDefined();
      expect(pluginCall?.mediaAccess?.readFile).toBeUndefined();
    });

    it("uses requester username policy for host-media reads", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "feishu",
        meta: {
          id: "feishu",
          label: "Feishu",
          selectionLabel: "Feishu",
          docsPath: "/channels/feishu",
          blurb: "Feishu username policy test plugin.",
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

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "feishu",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            feishu: {
              enabled: true,
            },
            whatsapp: {
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
          channel: "feishu",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderUsername: "alice_u",
        sessionKey: "agent:alpha:whatsapp:group:ops",
        dryRun: false,
      });

      const pluginCall = handlePolicyCheckedAction.mock.calls[0]?.[0];
      expect(pluginCall?.mediaAccess).toBeDefined();
      expect(pluginCall?.mediaAccess?.readFile).toBeUndefined();
    });

    it("uses requester account policy for host-media reads when destination account differs", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "feishu",
        meta: {
          id: "feishu",
          label: "Feishu",
          selectionLabel: "Feishu",
          docsPath: "/channels/feishu",
          blurb: "Feishu account policy test plugin.",
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

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "feishu",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            feishu: {
              enabled: true,
            },
            whatsapp: {
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
          channel: "feishu",
          accountId: "destination",
          target: "oc_123",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterAccountId: "source",
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:whatsapp:group:ops",
        dryRun: false,
      });

      const pluginCall = handlePolicyCheckedAction.mock.calls[0]?.[0];
      expect(pluginCall?.accountId).toBe("destination");
      expect(pluginCall?.mediaAccess).toBeDefined();
      expect(pluginCall?.mediaAccess?.readFile).toBeUndefined();
    });

    it("falls back to the resolved account policy when requester account is unavailable", async () => {
      const handlePolicyCheckedAction = vi.fn(async ({ mediaAccess }) =>
        jsonResult({
          ok: true,
          hasHostReadCapability: typeof mediaAccess?.readFile === "function",
        }),
      );
      const policyPlugin: ChannelPlugin = {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "WhatsApp account policy fallback test plugin.",
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

      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "whatsapp",
            source: "test",
            plugin: policyPlugin,
          },
        ]),
      );

      await runMessageAction({
        cfg: {
          tools: { allow: ["read"] },
          channels: {
            whatsapp: {
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
          channel: "whatsapp",
          accountId: "source",
          target: "group:ops",
          message: "hello",
          media: "/tmp/host.png",
        },
        requesterSenderId: "trusted-user",
        sessionKey: "agent:alpha:whatsapp:group:ops",
        dryRun: false,
      });

      const pluginCall = handlePolicyCheckedAction.mock.calls[0]?.[0];
      expect(pluginCall?.accountId).toBe("source");
      expect(pluginCall?.mediaAccess).toBeDefined();
      expect(pluginCall?.mediaAccess?.readFile).toBeUndefined();
    });
  });

  describe("card-only send behavior", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        card: params.card ?? null,
        message: params.message ?? null,
      }),
    );

    const cardPlugin: ChannelPlugin = {
      id: "cardchat",
      meta: {
        id: "cardchat",
        label: "Card Chat",
        selectionLabel: "Card Chat",
        docsPath: "/channels/cardchat",
        blurb: "Card-only send test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig(),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "cardchat",
            source: "test",
            plugin: cardPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("allows card-only sends without text or media", async () => {
      const cfg = {
        channels: {
          cardchat: {
            enabled: true,
          },
        },
      } as OpenClawConfig;

      const card = {
        type: "AdaptiveCard",
        version: "1.4",
        body: [{ type: "TextBlock", text: "Card-only payload" }],
      };

      const result = await runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "cardchat",
          target: "channel:test-card",
          card,
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("plugin");
      expect(handleAction).toHaveBeenCalled();
      expect(result.payload).toMatchObject({
        ok: true,
        card,
      });
    });
  });

  describe("telegram plugin poll forwarding", () => {
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

    const telegramPollPlugin = createPollForwardingPlugin({
      pluginId: "telegram",
      label: "Telegram",
      blurb: "Telegram poll forwarding test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: telegramPollPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("forwards telegram poll params through plugin dispatch", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            telegram: {
              botToken: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "telegram",
          target: "telegram:123",
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
      expect(handleAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "poll",
          channel: "telegram",
          params: expect.objectContaining({
            to: "telegram:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationSeconds: 120,
            pollPublic: true,
            threadId: "42",
          }),
        }),
      );
      expect(result.payload).toMatchObject({
        ok: true,
        forwarded: {
          to: "telegram:123",
          pollQuestion: "Lunch?",
          pollOption: ["Pizza", "Sushi"],
          pollDurationSeconds: 120,
          pollPublic: true,
          threadId: "42",
        },
      });
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

    const discordPollPlugin = createPollForwardingPlugin({
      pluginId: "discord",
      label: "Discord",
      blurb: "Discord plugin-owned poll test plugin.",
      handleAction,
    });

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: discordPollPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("lets non-telegram plugins own extra poll fields", async () => {
      const result = await runMessageAction({
        cfg: {
          channels: {
            discord: {
              token: "tok",
            },
          },
        } as OpenClawConfig,
        action: "poll",
        params: {
          channel: "discord",
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
      expect(handleAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "poll",
          channel: "discord",
          params: expect.objectContaining({
            to: "channel:123",
            pollQuestion: "Lunch?",
            pollOption: ["Pizza", "Sushi"],
            pollDurationSeconds: 120,
            pollPublic: true,
          }),
        }),
      );
    });
  });

  describe("components parsing", () => {
    const handleAction = vi.fn(async ({ params }: { params: Record<string, unknown> }) =>
      jsonResult({
        ok: true,
        components: params.components ?? null,
      }),
    );

    const componentsPlugin: ChannelPlugin = {
      id: "discord",
      meta: {
        id: "discord",
        label: "Discord",
        selectionLabel: "Discord",
        docsPath: "/channels/discord",
        blurb: "Discord components send test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: createAlwaysConfiguredPluginConfig({}),
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: componentsPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it("parses components JSON strings before plugin dispatch", async () => {
      const components = {
        text: "hello",
        buttons: [{ label: "A", customId: "a" }],
      };
      const result = await runMessageAction({
        cfg: {} as OpenClawConfig,
        action: "send",
        params: {
          channel: "discord",
          target: "channel:123",
          message: "hi",
          components: JSON.stringify(components),
        },
        dryRun: false,
      });

      expect(result.kind).toBe("send");
      expect(handleAction).toHaveBeenCalled();
      expect(result.payload).toMatchObject({ ok: true, components });
    });

    it("throws on invalid components JSON strings", async () => {
      await expect(
        runMessageAction({
          cfg: {} as OpenClawConfig,
          action: "send",
          params: {
            channel: "discord",
            target: "channel:123",
            message: "hi",
            components: "{not-json}",
          },
          dryRun: false,
        }),
      ).rejects.toThrow(/--components must be valid JSON/);

      expect(handleAction).not.toHaveBeenCalled();
    });
  });

  describe("accountId defaults", () => {
    const handleAction = vi.fn(async () => jsonResult({ ok: true }));
    const accountPlugin: ChannelPlugin = {
      id: "discord",
      meta: {
        id: "discord",
        label: "Discord",
        selectionLabel: "Discord",
        docsPath: "/channels/discord",
        blurb: "Discord test plugin.",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({}),
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        handleAction,
      },
    };

    beforeEach(() => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: accountPlugin,
          },
        ]),
      );
      handleAction.mockClear();
    });

    afterEach(() => {
      setActivePluginRegistry(createTestRegistry([]));
      vi.clearAllMocks();
    });

    it.each([
      {
        name: "uses defaultAccountId override",
        args: {
          cfg: {} as OpenClawConfig,
          defaultAccountId: "ops",
        },
        expectedAccountId: "ops",
      },
      {
        name: "falls back to agent binding account",
        args: {
          cfg: {
            bindings: [
              { agentId: "agent-b", match: { channel: "discord", accountId: "account-b" } },
            ],
          } as OpenClawConfig,
          agentId: "agent-b",
        },
        expectedAccountId: "account-b",
      },
    ])("$name", async ({ args, expectedAccountId }) => {
      await runMessageAction({
        ...args,
        action: "send",
        params: {
          channel: "discord",
          target: "channel:123",
          message: "hi",
        },
      });

      expect(handleAction).toHaveBeenCalled();
      const ctx = (handleAction.mock.calls as unknown as Array<[unknown]>)[0]?.[0] as
        | {
            accountId?: string | null;
            params: Record<string, unknown>;
          }
        | undefined;
      if (!ctx) {
        throw new Error("expected action context");
      }
      expect(ctx.accountId).toBe(expectedAccountId);
      expect(ctx.params.accountId).toBe(expectedAccountId);
    });
  });
});
