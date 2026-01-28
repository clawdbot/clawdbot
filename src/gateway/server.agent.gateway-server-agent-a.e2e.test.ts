import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  agentCommand,
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

const registryState = vi.hoisted(() => ({
  registry: {
    plugins: [],
    tools: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    diagnostics: [],
  } as PluginRegistry,
}));

vi.mock("./server-plugins.js", async () => {
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  return {
    loadGatewayPlugins: (params: { baseMethods: string[] }) => {
      setActivePluginRegistry(registryState.registry);
      return {
        pluginRegistry: registryState.registry,
        gatewayMethods: params.baseMethods ?? [],
      };
    },
  };
});

const setRegistry = (registry: PluginRegistry) => {
  registryState.registry = registry;
  setActivePluginRegistry(registry);
};

const BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

function expectChannels(call: Record<string, unknown>, channel: string) {
  expect(call.channel).toBe(channel);
  expect(call.messageChannel).toBe(channel);
  const runContext = call.runContext as { messageChannel?: string } | undefined;
  expect(runContext?.messageChannel).toBe(channel);
}

const createRegistry = (channels: PluginRegistry["channels"]): PluginRegistry => ({
  plugins: [],
  tools: [],
  channels,
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics: [],
});

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
  resolveAllowFrom?: (cfg: Record<string, unknown>) => string[];
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label,
    selectionLabel: params.label,
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    resolveAllowFrom: params.resolveAllowFrom
      ? ({ cfg }) => params.resolveAllowFrom?.(cfg as Record<string, unknown>) ?? []
      : undefined,
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) return { ok: true, to: trimmed };
      const first = allowFrom?.[0];
      if (first) return { ok: true, to: String(first) };
      return {
        ok: false,
        error: new Error(`missing target for ${params.id}`),
      };
    },
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: createStubChannelPlugin({
      id: "whatsapp",
      label: "WhatsApp",
      resolveAllowFrom: (cfg) => {
        const channels = cfg.channels as Record<string, unknown> | undefined;
        const entry = channels?.whatsapp as Record<string, unknown> | undefined;
        const allow = entry?.allowFrom;
        return Array.isArray(allow) ? allow.map((value) => String(value)) : [];
      },
    }),
  },
  {
    pluginId: "telegram",
    source: "test",
    plugin: createStubChannelPlugin({ id: "telegram", label: "Telegram" }),
  },
  {
    pluginId: "discord",
    source: "test",
    plugin: createStubChannelPlugin({ id: "discord", label: "Discord" }),
  },
  {
    pluginId: "slack",
    source: "test",
    plugin: createStubChannelPlugin({ id: "slack", label: "Slack" }),
  },
  {
    pluginId: "signal",
    source: "test",
    plugin: createStubChannelPlugin({ id: "signal", label: "Signal" }),
  },
]);

describe("gateway server agent", () => {
  test("agent marks implicit delivery when lastTo is stale", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+436769770569"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-stale",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-stale",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliveryTargetMode).toBe("implicit");
    expect(call.sessionId).toBe("sess-main-stale");
    testState.allowFrom = undefined;
  });

  test("agent forwards sessionKey to agentCommand", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        "agent:main:subagent:abc": {
          sessionId: "sess-sub",
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "agent:main:subagent:abc",
      idempotencyKey: "idem-agent-subkey",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.sessionKey).toBe("agent:main:subagent:abc");
    expect(call.sessionId).toBe("sess-sub");
    expectChannels(call, "webchat");
    expect(call.deliver).toBe(false);
    expect(call.to).toBeUndefined();
  });

  test("agent derives sessionKey from agentId", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    testState.agentsConfig = { list: [{ id: "ops" }] };
    await writeSessionStore({
      agentId: "ops",
      entries: {
        main: {
          sessionId: "sess-ops",
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      agentId: "ops",
      idempotencyKey: "idem-agent-id",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.sessionKey).toBe("agent:ops:main");
    expect(call.sessionId).toBe("sess-ops");
  });

  test("agent rejects unknown reply channel", async () => {
    setRegistry(defaultRegistry);
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      replyChannel: "unknown-channel",
      idempotencyKey: "idem-agent-reply-unknown",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("unknown channel");

    const spy = vi.mocked(agentCommand);
    expect(spy).not.toHaveBeenCalled();
  });

  test("agent rejects mismatched agentId and sessionKey", async () => {
    setRegistry(defaultRegistry);
    testState.agentsConfig = { list: [{ id: "ops" }] };
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      agentId: "ops",
      sessionKey: "agent:main:main",
      idempotencyKey: "idem-agent-mismatch",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("does not match session key agent");

    const spy = vi.mocked(agentCommand);
    expect(spy).not.toHaveBeenCalled();
  });

  test("agent forwards accountId to agentCommand", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-account",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
          lastAccountId: "default",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      accountId: "kev",
      idempotencyKey: "idem-agent-account",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.accountId).toBe("kev");
    const runContext = call.runContext as { accountId?: string } | undefined;
    expect(runContext?.accountId).toBe("kev");
    testState.allowFrom = undefined;
  });

  test("agent avoids lastAccountId when explicit to is provided", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-explicit",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
          lastAccountId: "legacy",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      to: "+1666",
      idempotencyKey: "idem-agent-explicit",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1666");
    expect(call.accountId).toBeUndefined();
    testState.allowFrom = undefined;
  });

  test("agent keeps explicit accountId when explicit to is provided", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-explicit-account",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
          lastAccountId: "legacy",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      to: "+1666",
      accountId: "primary",
      idempotencyKey: "idem-agent-explicit-account",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1666");
    expect(call.accountId).toBe("primary");
    testState.allowFrom = undefined;
  });

  test("agent falls back to lastAccountId for implicit delivery", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-implicit",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
          lastAccountId: "kev",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      idempotencyKey: "idem-agent-implicit-account",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.accountId).toBe("kev");
    testState.allowFrom = undefined;
  });

  test("agent forwards image attachments as images[]", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-images",
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "what is in the image?",
      sessionKey: "main",
      attachments: [
        {
          mimeType: "image/png",
          fileName: "tiny.png",
          content: BASE_IMAGE_PNG,
        },
      ],
      idempotencyKey: "idem-agent-attachments",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.sessionKey).toBe("main");
    expectChannels(call, "webchat");
    expect(call.message).toBe("what is in the image?");

    const images = call.images as Array<Record<string, unknown>>;
    expect(Array.isArray(images)).toBe(true);
    expect(images.length).toBe(1);
    expect(images[0]?.type).toBe("image");
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data).toBe(BASE_IMAGE_PNG);
  });

  test("agent falls back to whatsapp when delivery requested and no last channel exists", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-missing-provider",
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      idempotencyKey: "idem-agent-missing-provider",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-missing-provider");
    testState.allowFrom = undefined;
  });

  test("agent routes main last-channel whatsapp", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-whatsapp",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "+1555",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-whatsapp",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.messageChannel).toBe("whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-whatsapp");
  });

  test("agent routes main last-channel telegram", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "123",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "telegram");
    expect(call.to).toBe("123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main");
  });

  test("agent routes main last-channel discord", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-discord",
          updatedAt: Date.now(),
          lastChannel: "discord",
          lastTo: "channel:discord-123",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-discord",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "discord");
    expect(call.to).toBe("channel:discord-123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-discord");
  });

  test("agent routes main last-channel slack", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-slack",
          updatedAt: Date.now(),
          lastChannel: "slack",
          lastTo: "channel:slack-123",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-slack",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "slack");
    expect(call.to).toBe("channel:slack-123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-slack");
  });

  test("agent routes main last-channel signal", async () => {
    setRegistry(defaultRegistry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-signal",
          updatedAt: Date.now(),
          lastChannel: "signal",
          lastTo: "+15551234567",
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-signal",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "signal");
    expect(call.to).toBe("+15551234567");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-signal");
  });
});
