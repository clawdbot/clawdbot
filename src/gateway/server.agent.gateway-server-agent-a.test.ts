import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
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
let sharedSessionStoreDir: string;
let sharedSessionStorePath: string;

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
  sharedSessionStoreDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-session-"));
  sharedSessionStorePath = path.join(sharedSessionStoreDir, "sessions.json");
});

afterAll(async () => {
  ws.close();
  await server.close();
  await fs.rm(sharedSessionStoreDir, { recursive: true, force: true });
});

const BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

type AgentCommandCall = Record<string, unknown>;

function expectChannels(call: Record<string, unknown>, channel: string) {
  expect(call.channel).toBe(channel);
  expect(call.messageChannel).toBe(channel);
  const runContext = call.runContext as { messageChannel?: string } | undefined;
  expect(runContext?.messageChannel).toBe(channel);
}

async function setTestSessionStore(params: {
  entries: Record<string, Record<string, unknown>>;
  agentId?: string;
}) {
  testState.sessionStorePath = sharedSessionStorePath;
  await writeSessionStore({
    entries: params.entries,
    agentId: params.agentId,
  });
}

function latestAgentCall(): AgentCommandCall {
  const calls = vi.mocked(agentCommand).mock.calls as unknown as Array<[unknown]>;
  return calls.at(-1)?.[0] as AgentCommandCall;
}

async function runMainAgentDeliveryWithSession(params: {
  entry: Record<string, unknown>;
  request: Record<string, unknown>;
  allowFrom?: string[];
}) {
  setRegistry(defaultRegistry);
  testState.allowFrom = params.allowFrom ?? ["+1555"];
  try {
    await setTestSessionStore({
      entries: {
        main: {
          ...params.entry,
          updatedAt: Date.now(),
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      ...params.request,
    });
    expect(res.ok).toBe(true);
    return latestAgentCall();
  } finally {
    testState.allowFrom = undefined;
  }
}

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
  resolveAllowFrom?: (cfg: Record<string, unknown>) => string[];
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: {
      resolveAllowFrom: params.resolveAllowFrom
        ? ({ cfg }) => params.resolveAllowFrom?.(cfg as Record<string, unknown>) ?? []
        : undefined,
    },
  }),
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed) {
        return { ok: true, to: trimmed };
      }
      const first = allowFrom?.[0];
      if (first) {
        return { ok: true, to: first };
      }
      return {
        ok: false,
        error: new Error(`missing target for ${params.id}`),
      };
    },
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const defaultDirectChannelEntries = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "signal", label: "Signal" },
] as const;

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
  ...defaultDirectChannelEntries.map((entry) => ({
    pluginId: entry.id,
    source: "test",
    plugin: createStubChannelPlugin({ id: entry.id, label: entry.label }),
  })),
]);

describe("gateway server agent", () => {
  test("agent marks implicit delivery when lastTo is stale", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+436769770569"];
    await setTestSessionStore({
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

    const call = latestAgentCall();
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliveryTargetMode).toBe("implicit");
    expect(call.sessionId).toBe("sess-main-stale");
    testState.allowFrom = undefined;
  });

  test("agent forwards sessionKey to agentCommand", async () => {
    setRegistry(defaultRegistry);
    await setTestSessionStore({
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

    const call = latestAgentCall();
    expect(call.sessionKey).toBe("agent:main:subagent:abc");
    expect(call.sessionId).toBe("sess-sub");
    expectChannels(call, "webchat");
    expect(call.deliver).toBe(false);
    expect(call.to).toBeUndefined();
  });

  test("agent preserves spawnDepth on subagent sessions", async () => {
    setRegistry(defaultRegistry);
    await setTestSessionStore({
      entries: {
        "agent:main:subagent:depth": {
          sessionId: "sess-sub-depth",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnDepth: 2,
        },
      },
    });

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "agent:main:subagent:depth",
      idempotencyKey: "idem-agent-subdepth",
    });
    expect(res.ok).toBe(true);

    const raw = await fs.readFile(sharedSessionStorePath, "utf-8");
    const persisted = JSON.parse(raw) as Record<
      string,
      { spawnDepth?: number; spawnedBy?: string }
    >;
    expect(persisted["agent:main:subagent:depth"]?.spawnDepth).toBe(2);
    expect(persisted["agent:main:subagent:depth"]?.spawnedBy).toBe("agent:main:main");
  });

  test("agent derives sessionKey from agentId", async () => {
    setRegistry(defaultRegistry);
    await setTestSessionStore({
      agentId: "ops",
      entries: {
        main: {
          sessionId: "sess-ops",
          updatedAt: Date.now(),
        },
      },
    });
    testState.agentsConfig = { list: [{ id: "ops" }] };
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      agentId: "ops",
      idempotencyKey: "idem-agent-id",
    });
    expect(res.ok).toBe(true);

    const call = latestAgentCall();
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

  test("agent rejects malformed agent-prefixed session keys", async () => {
    setRegistry(defaultRegistry);
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "agent:main",
      idempotencyKey: "idem-agent-malformed-key",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("malformed session key");

    const spy = vi.mocked(agentCommand);
    expect(spy).not.toHaveBeenCalled();
  });

  test("agent forwards accountId to agentCommand", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-account",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "default",
      },
      request: {
        accountId: "kev",
        idempotencyKey: "idem-agent-account",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.accountId).toBe("kev");
    const runContext = call.runContext as { accountId?: string } | undefined;
    expect(runContext?.accountId).toBe("kev");
  });

  test("agent avoids lastAccountId when explicit to is provided", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-explicit",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "legacy",
      },
      request: {
        to: "+1666",
        idempotencyKey: "idem-agent-explicit",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1666");
    expect(call.accountId).toBeUndefined();
  });

  test("agent keeps explicit accountId when explicit to is provided", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-explicit-account",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "legacy",
      },
      request: {
        to: "+1666",
        accountId: "primary",
        idempotencyKey: "idem-agent-explicit-account",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1666");
    expect(call.accountId).toBe("primary");
  });

  test("agent falls back to lastAccountId for implicit delivery", async () => {
    const call = await runMainAgentDeliveryWithSession({
      entry: {
        sessionId: "sess-main-implicit",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "kev",
      },
      request: {
        idempotencyKey: "idem-agent-implicit-account",
      },
    });

    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.accountId).toBe("kev");
  });

  test("agent forwards image attachments as images[]", async () => {
    setRegistry(defaultRegistry);
    await setTestSessionStore({
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

    const call = latestAgentCall();
    expect(call.sessionKey).toBe("agent:main:main");
    expectChannels(call, "webchat");
    expect(typeof call.message).toBe("string");
    expect(call.message).toContain("what is in the image?");

    const images = call.images as Array<Record<string, unknown>>;
    expect(Array.isArray(images)).toBe(true);
    expect(images.length).toBe(1);
    expect(images[0]?.type).toBe("image");
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data).toBe(BASE_IMAGE_PNG);
  });

  test("agent errors when delivery requested and no last channel exists", async () => {
    setRegistry(defaultRegistry);
    testState.allowFrom = ["+1555"];
    try {
      await setTestSessionStore({
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
        bestEffortDeliver: false,
        idempotencyKey: "idem-agent-missing-provider",
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("INVALID_REQUEST");
      expect(res.error?.message).toContain("Channel is required");
      expect(vi.mocked(agentCommand)).not.toHaveBeenCalled();
    } finally {
      testState.allowFrom = undefined;
    }
  });

  test.each([
    {
      name: "whatsapp",
      sessionId: "sess-main-whatsapp",
      lastChannel: "whatsapp",
      lastTo: "+1555",
      idempotencyKey: "idem-agent-last-whatsapp",
    },
    {
      name: "telegram",
      sessionId: "sess-main",
      lastChannel: "telegram",
      lastTo: "123",
      idempotencyKey: "idem-agent-last",
    },
    {
      name: "discord",
      sessionId: "sess-discord",
      lastChannel: "discord",
      lastTo: "channel:discord-123",
      idempotencyKey: "idem-agent-last-discord",
    },
    {
      name: "slack",
      sessionId: "sess-slack",
      lastChannel: "slack",
      lastTo: "channel:slack-123",
      idempotencyKey: "idem-agent-last-slack",
    },
    {
      name: "signal",
      sessionId: "sess-signal",
      lastChannel: "signal",
      lastTo: "+15551234567",
      idempotencyKey: "idem-agent-last-signal",
    },
  ])("agent routes main last-channel $name", async (tc) => {
    setRegistry(defaultRegistry);
    await setTestSessionStore({
      entries: {
        main: {
          sessionId: tc.sessionId,
          updatedAt: Date.now(),
          lastChannel: tc.lastChannel,
          lastTo: tc.lastTo,
        },
      },
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: tc.idempotencyKey,
    });
    expect(res.ok).toBe(true);

    const call = latestAgentCall();
    expectChannels(call, tc.lastChannel);
    expect(call.to).toBe(tc.lastTo);
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe(tc.sessionId);
  });
});
