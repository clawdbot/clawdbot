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

function gatewayCall(): {
  url?: string;
  token?: string;
  timeoutMs?: number;
  params?: Record<string, unknown>;
} {
  const [call] = callGatewayMock.mock.calls;
  if (!call) {
    throw new Error("expected gateway call");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected gateway call input to be an object");
  }
  return arg as {
    url?: string;
    token?: string;
    timeoutMs?: number;
    params?: Record<string, unknown>;
  };
}

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
    const localChatAliasPlugin: ChannelPlugin = {
      id: "localchat",
      meta: {
        id: "localchat",
        label: "LocalChat",
        selectionLabel: "LocalChat",
        docsPath: "/channels/localchat",
        blurb: "LocalChat test stub.",
        aliases: ["localmsg"],
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
          const normalized = (to ?? "").trim().replace(/^localchat:/i, "");
          return { ok: true, to: normalized };
        },
        sendText: async ({ cfg, to }) => {
          seen.sendCfg = cfg;
          seen.to = to;
          return { channel: "localchat", messageId: "local-resolved" };
        },
        sendMedia: async ({ cfg, to }) => {
          seen.sendCfg = cfg;
          seen.to = to;
          return { channel: "localchat", messageId: "local-resolved-media" };
        },
      },
    };

    setRegistry(
      createTestRegistry([
        {
          pluginId: "localchat",
          source: "test",
          plugin: localChatAliasPlugin,
        },
      ]),
    );

    const result = await sendMessage({
      cfg: resolvedCfg,
      to: " localchat:+15551234567 ",
      content: "hi",
      channel: "localmsg",
    });

    expect(result.channel).toBe("localchat");
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
      name: "normalizes direct local aliases",
      registry: createTestRegistry([
        {
          pluginId: "localchat",
          source: "test",
          plugin: createLocalChatAliasPlugin(),
        },
      ]),
      params: {
        to: "someone@example.com",
        channel: "localmsg",
        deps: {
          localchat: vi.fn(async () => ({ messageId: "local1" })),
        },
      },
      assertDeps: (deps: { localchat?: ReturnType<typeof vi.fn> }) => {
        expect(deps.localchat).toHaveBeenCalledTimes(1);
        const [to, text, options] = deps.localchat?.mock.calls.at(0) ?? [];
        expect(to).toBe("someone@example.com");
        expect(text).toBe("hi");
        expect(typeof options).toBe("object");
      },
      expectedChannel: "localchat",
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
  const setupThreadChatCapture = () => {
    const capturedCtx: Record<string, unknown>[] = [];
    const plugin = createThreadChatLikePlugin({
      onSendText: (ctx) => {
        capturedCtx.push(ctx);
      },
    });
    setRegistry(createTestRegistry([{ pluginId: "threadchat", source: "test", plugin }]));
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
    const capturedCtx = setupThreadChatCapture();

    await sendMessage({
      cfg: {},
      to: "channel:town-square",
      channel: "threadchat",
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

const setThreadChatGatewayRegistry = () => {
  setRegistry(
    createTestRegistry([
      {
        pluginId: "threadchat",
        source: "test",
        plugin: {
          ...createThreadChatLikePlugin({ onSendText: () => {} }),
          outbound: { deliveryMode: "gateway" },
        },
      },
    ]),
  );
};

describe("gateway url override hardening", () => {
  const sendThreadChatGatewayMessage = async (
    params: Partial<Parameters<typeof sendMessage>[0]> = {},
  ) => {
    setThreadChatGatewayRegistry();
    callGatewayMock.mockResolvedValueOnce({
      messageId: params.agentId ? "m-agent" : "m1",
    });
    await sendMessage({
      cfg: {},
      to: "channel:town-square",
      content: "hi",
      channel: "threadchat",
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
    {
      name: "forwards replyToId in gateway send params",
      params: {
        replyToId: "wamid.42",
      },
      expected: {
        params: {
          replyToId: "wamid.42",
        },
      },
    },
    {
      name: "forwards gateway delivery options in send params",
      params: {
        threadId: "topic456",
        forceDocument: true,
        silent: true,
        parseMode: "HTML" as const,
      },
      expected: {
        params: {
          threadId: "topic456",
          forceDocument: true,
          silent: true,
          parseMode: "HTML",
        },
      },
    },
  ])("$name", async ({ params, expected }) => {
    const result = await sendThreadChatGatewayMessage(params);
    for (const [key, value] of Object.entries(expected)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          expect(
            ((result as Record<string, unknown>)[key] as Record<string, unknown>)[nestedKey],
          ).toEqual(nestedValue);
        }
        continue;
      }
      expect((result as Record<string, unknown>)[key]).toEqual(value);
    }
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

const createLocalChatAliasPlugin = (): ChannelPlugin => ({
  id: "localchat",
  meta: {
    id: "localchat",
    label: "LocalChat",
    selectionLabel: "LocalChat (localmsg)",
    docsPath: "/channels/localchat",
    blurb: "LocalChat test stub.",
    aliases: ["localmsg"],
  },
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ deps, to, text }) => {
      const send = deps?.localchat as
        | ((to: string, text: string, opts?: unknown) => Promise<{ messageId: string }>)
        | undefined;
      if (!send) {
        throw new Error("localchat missing");
      }
      const result = await send(to, text, {});
      return { channel: "localchat", ...result };
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

const createThreadChatLikePlugin = (opts: {
  onSendText: (ctx: Record<string, unknown>) => void;
}): ChannelPlugin => ({
  id: "threadchat",
  meta: {
    id: "threadchat",
    label: "ThreadChat",
    selectionLabel: "ThreadChat",
    docsPath: "/channels/threadchat",
    blurb: "ThreadChat test stub.",
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
      return { channel: "threadchat", messageId: "m1" };
    },
    sendMedia: async () => ({ channel: "threadchat", messageId: "m2" }),
  },
});
