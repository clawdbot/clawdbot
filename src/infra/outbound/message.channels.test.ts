import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../../channels/plugins/types.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

const setRegistry = (registry: ReturnType<typeof createTestRegistry>) => {
  setActivePluginRegistry(registry);
};

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  callGatewayLeastPrivilege: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

let sendMessage: typeof import("./message.js").sendMessage;
let sendPoll: typeof import("./message.js").sendPoll;

beforeAll(async () => {
  ({ sendMessage, sendPoll } = await import("./message.js"));
});

beforeEach(() => {
  callGatewayMock.mockClear();
  setRegistry(emptyRegistry);
});

afterEach(() => {
  setRegistry(emptyRegistry);
});

const gatewayCall = () =>
  callGatewayMock.mock.calls[0]?.[0] as {
    url?: string;
    token?: string;
    timeoutMs?: number;
    params?: Record<string, unknown>;
  };

describe("sendMessage channel normalization", () => {
  it("threads resolved cfg through alias + target normalization in outbound dispatch", async () => {
    const resolvedCfg = {
      __resolvedCfgMarker: "cfg-from-secret-resolution",
      channels: {},
    } as Record<string, unknown>;
    const seen: {
      resolveCfg?: unknown;
      sendCfg?: unknown;
      to?: string;
    } = {};
    const imessageAliasPlugin: ChannelPlugin = {
      id: "imessage",
      meta: {
        id: "imessage",
        label: "iMessage",
        selectionLabel: "iMessage",
        docsPath: "/channels/imessage",
        blurb: "iMessage test stub.",
        aliases: ["imsg"],
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      outbound: {
        deliveryMode: "direct",
        resolveTarget: ({ to, cfg }) => {
          seen.resolveCfg = cfg;
          const normalized = (to ?? "").trim().replace(/^imessage:/i, "");
          return { ok: true, to: normalized };
        },
        sendText: async ({ cfg, to }) => {
          seen.sendCfg = cfg;
          seen.to = to;
          return { channel: "imessage", messageId: "i-resolved" };
        },
        sendMedia: async ({ cfg, to }) => {
          seen.sendCfg = cfg;
          seen.to = to;
          return { channel: "imessage", messageId: "i-resolved-media" };
        },
      },
    };

    setRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: imessageAliasPlugin,
        },
      ]),
    );

    const result = await sendMessage({
      cfg: resolvedCfg,
      to: " imessage:+15551234567 ",
      content: "hi",
      channel: "imsg",
    });

    expect(result.channel).toBe("imessage");
    expect(seen.resolveCfg).toBe(resolvedCfg);
    expect(seen.sendCfg).toBe(resolvedCfg);
    expect(seen.to).toBe("+15551234567");
  });

  it.each([
    {
      name: "normalizes plugin aliases",
      registry: createTestRegistry([
        {
          pluginId: "demo-alias-channel",
          source: "test",
          plugin: createDemoAliasPlugin({
            outbound: createDemoAliasOutbound(),
            aliases: ["workspace-chat"],
          }),
        },
      ]),
      params: {
        to: "conversation:demo-target",
        channel: "workspace-chat",
        deps: {
          "demo-alias-channel": vi.fn(async () => ({
            messageId: "m1",
            conversationId: "c1",
          })),
        },
      },
      assertDeps: (deps: { "demo-alias-channel"?: ReturnType<typeof vi.fn> }) => {
        expect(deps["demo-alias-channel"]).toHaveBeenCalledWith("conversation:demo-target", "hi");
      },
      expectedChannel: "demo-alias-channel",
    },
    {
      name: "normalizes iMessage aliases",
      registry: createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageAliasPlugin(),
        },
      ]),
      params: {
        to: "someone@example.com",
        channel: "imsg",
        deps: {
          imessage: vi.fn(async () => ({ messageId: "i1" })),
        },
      },
      assertDeps: (deps: { imessage?: ReturnType<typeof vi.fn> }) => {
        expect(deps.imessage).toHaveBeenCalledWith("someone@example.com", "hi", expect.any(Object));
      },
      expectedChannel: "imessage",
    },
  ])("$name", async ({ registry, params, assertDeps, expectedChannel }) => {
    setRegistry(registry);

    const result = await sendMessage({
      cfg: {},
      content: "hi",
      ...params,
    });

    assertDeps(params.deps);
    expect(result.channel).toBe(expectedChannel);
  });
});

describe("sendMessage replyToId threading", () => {
  const setupMattermostCapture = () => {
    const capturedCtx: Record<string, unknown>[] = [];
    const plugin = createMattermostLikePlugin({
      onSendText: (ctx) => {
        capturedCtx.push(ctx);
      },
    });
    setRegistry(createTestRegistry([{ pluginId: "mattermost", source: "test", plugin }]));
    return capturedCtx;
  };

  it.each([
    {
      name: "passes replyToId through to the outbound adapter",
      params: { content: "thread reply", replyToId: "post123" },
      field: "replyToId",
      expected: "post123",
    },
    {
      name: "passes threadId through to the outbound adapter",
      params: { content: "topic reply", threadId: "topic456" },
      field: "threadId",
      expected: "topic456",
    },
  ])("$name", async ({ params, field, expected }) => {
    const capturedCtx = setupMattermostCapture();

    await sendMessage({
      cfg: {},
      to: "channel:town-square",
      channel: "mattermost",
      ...params,
    });

    expect(capturedCtx).toHaveLength(1);
    expect(capturedCtx[0]?.[field]).toBe(expected);
  });
});

describe("sendPoll channel normalization", () => {
  it("normalizes plugin aliases for polls", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "p1" });
    setRegistry(
      createTestRegistry([
        {
          pluginId: "demo-alias-channel",
          source: "test",
          plugin: createDemoAliasPlugin({
            aliases: ["workspace-chat"],
            outbound: createDemoAliasOutbound({ includePoll: true }),
          }),
        },
      ]),
    );

    const result = await sendPoll({
      cfg: {},
      to: "conversation:demo-target",
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
      channel: "Workspace-Chat",
    });

    expect(gatewayCall()?.params?.channel).toBe("demo-alias-channel");
    expect(result.channel).toBe("demo-alias-channel");
  });
});

const setMattermostGatewayRegistry = () => {
  setRegistry(
    createTestRegistry([
      {
        pluginId: "mattermost",
        source: "test",
        plugin: {
          ...createMattermostLikePlugin({ onSendText: () => {} }),
          outbound: { deliveryMode: "gateway" },
        },
      },
    ]),
  );
};

describe("gateway url override hardening", () => {
  const sendMattermostGatewayMessage = async (
    params: Partial<Parameters<typeof sendMessage>[0]> = {},
  ) => {
    setMattermostGatewayRegistry();
    callGatewayMock.mockResolvedValueOnce({
      messageId: params.agentId ? "m-agent" : "m1",
    });
    await sendMessage({
      cfg: {},
      to: "channel:town-square",
      content: "hi",
      channel: "mattermost",
      ...params,
    });
    return gatewayCall();
  };

  it.each([
    {
      name: "drops gateway url overrides in backend mode (SSRF hardening)",
      params: {
        gateway: {
          url: "ws://169.254.169.254:80/latest/meta-data/",
          token: "t",
          timeoutMs: 5000,
          clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          clientDisplayName: "agent",
          mode: GATEWAY_CLIENT_MODES.BACKEND,
        },
      },
      expected: {
        url: undefined,
        token: "t",
        timeoutMs: 5000,
      },
    },
    {
      name: "forwards explicit agentId in gateway send params",
      params: {
        agentId: "work",
      },
      expected: {
        params: {
          agentId: "work",
        },
      },
    },
  ])("$name", async ({ params, expected }) => {
    expect(await sendMattermostGatewayMessage(params)).toMatchObject(expected);
  });
});

const emptyRegistry = createTestRegistry([]);

const createDemoAliasPlugin = (params?: {
  aliases?: string[];
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => {
  const base = createChannelTestPluginBase({
    id: "demo-alias-channel",
    label: "Demo Alias Channel",
    docsPath: "/channels/demo-alias-channel",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(params?.aliases ? { aliases: params.aliases } : {}),
    },
    ...(params?.outbound ? { outbound: params.outbound } : {}),
  };
};

const createIMessageAliasPlugin = (): ChannelPlugin => ({
  id: "imessage",
  meta: {
    id: "imessage",
    label: "iMessage",
    selectionLabel: "iMessage (imsg)",
    docsPath: "/channels/imessage",
    blurb: "iMessage test stub.",
    aliases: ["imsg"],
  },
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ deps, to, text }) => {
      const send = deps?.imessage as
        | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
        | undefined;
      if (!send) {
        throw new Error("imessage missing");
      }
      const result = await send(to, text, {});
      return { channel: "imessage", ...result };
    },
  },
});

const createDemoAliasOutbound = (opts?: { includePoll?: boolean }): ChannelOutboundAdapter => ({
  deliveryMode: "direct",
  sendText: async ({ deps, to, text }) => {
    const send = deps?.["demo-alias-channel"] as
      | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
      | undefined;
    if (!send) {
      throw new Error("demo-alias-channel missing");
    }
    const result = await send(to, text);
    return { channel: "demo-alias-channel", ...result };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    const send = deps?.["demo-alias-channel"] as
      | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
      | undefined;
    if (!send) {
      throw new Error("demo-alias-channel missing");
    }
    const result = await send(to, text, { mediaUrl });
    return { channel: "demo-alias-channel", ...result };
  },
  ...(opts?.includePoll
    ? {
        pollMaxOptions: 12,
        sendPoll: async () => ({ channel: "demo-alias-channel", messageId: "p1" }),
      }
    : {}),
});

const createMattermostLikePlugin = (opts: {
  onSendText: (ctx: Record<string, unknown>) => void;
}): ChannelPlugin => ({
  id: "mattermost",
  meta: {
    id: "mattermost",
    label: "Mattermost",
    selectionLabel: "Mattermost",
    docsPath: "/channels/mattermost",
    blurb: "Mattermost test stub.",
  },
  capabilities: { chatTypes: ["direct", "channel"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      opts.onSendText(ctx as unknown as Record<string, unknown>);
      return { channel: "mattermost", messageId: "m1" };
    },
    sendMedia: async () => ({ channel: "mattermost", messageId: "m2" }),
  },
});
