import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { setRegistry } from "./server.agent.gateway-server-agent.mocks.js";
import { createRegistry } from "./server.e2e-registry-helpers.js";
import {
  agentCommand,
  connectOk,
  connectWebchatClient,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startConnectedServerWithClient,
  startServerWithClient,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];
let port: number;

beforeAll(async () => {
  const started = await startConnectedServerWithClient();
  server = started.server;
  ws = started.ws;
  port = started.port;
});

afterAll(async () => {
  ws.close();
  await server.close();
});

const createMSTeamsPlugin = (params?: { aliases?: string[] }): ChannelPlugin => ({
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    blurb: "Teams SDK; enterprise support.",
    aliases: params?.aliases,
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
});

const createStubChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
  }),
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const createConfiguredChannelPlugin = (params: {
  id: ChannelPlugin["id"];
  label: string;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isConfigured: async () => true,
    },
  }),
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ channel: params.id, messageId: "msg-test" }),
    sendMedia: async () => ({ channel: params.id, messageId: "msg-test" }),
  },
});

const emptyRegistry = createRegistry([]);
const defaultRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: createStubChannelPlugin({ id: "whatsapp", label: "WhatsApp" }),
  },
]);

function expectChannels(call: Record<string, unknown>, channel: string) {
  expect(call.channel).toBe(channel);
  expect(call.messageChannel).toBe(channel);
}

function readAgentCommandCall(fromEnd = 1) {
  const calls = vi.mocked(agentCommand).mock.calls;
  return (calls.at(-fromEnd)?.[0] ?? {}) as Record<string, unknown>;
}

function expectAgentRoutingCall(params: {
  channel: string;
  deliver: boolean;
  to?: string;
  fromEnd?: number;
}) {
  const call = readAgentCommandCall(params.fromEnd);
  expectChannels(call, params.channel);
  if ("to" in params) {
    expect(call.to).toBe(params.to);
  } else {
    expect(call.to).toBeUndefined();
  }
  expect(call.deliver).toBe(params.deliver);
  expect(call.bestEffortDeliver).toBe(true);
  expect(typeof call.sessionId).toBe("string");
}

async function writeMainSessionEntry(params: {
  sessionId: string;
  lastChannel?: string;
  lastTo?: string;
}) {
  await useTempSessionStorePath();
  await writeSessionStore({
    entries: {
      main: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        lastChannel: params.lastChannel,
        lastTo: params.lastTo,
      },
    },
  });
}

function sendAgentWsRequest(
  socket: WebSocket,
  params: { reqId: string; message: string; idempotencyKey: string },
) {
  socket.send(
    JSON.stringify({
      type: "req",
      id: params.reqId,
      method: "agent",
      params: { message: params.message, idempotencyKey: params.idempotencyKey },
    }),
  );
}

async function sendAgentWsRequestAndWaitFinal(
  socket: WebSocket,
  params: { reqId: string; message: string; idempotencyKey: string; timeoutMs?: number },
) {
  const finalP = onceMessage(
    socket,
    (o) => o.type === "res" && o.id === params.reqId && o.payload?.status !== "accepted",
    params.timeoutMs,
  );
  sendAgentWsRequest(socket, params);
  return await finalP;
}

async function useTempSessionStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
  testState.sessionStorePath = path.join(dir, "sessions.json");
}

describe("gateway server agent", () => {
  beforeEach(() => {
    setRegistry(defaultRegistry);
  });

  afterEach(() => {
    setRegistry(emptyRegistry);
  });

  test("agent reuses the last plugin delivery route when channel=last", async () => {
    const registry = createRegistry([
      {
        pluginId: "msteams",
        source: "test",
        plugin: createMSTeamsPlugin(),
      },
    ]);
    setRegistry(registry);
    await writeMainSessionEntry({
      sessionId: "sess-teams",
      lastChannel: "msteams",
      lastTo: "conversation:teams-123",
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-msteams",
    });
    expect(res.ok).toBe(true);
    expectAgentRoutingCall({
      channel: "msteams",
      deliver: true,
      to: "conversation:teams-123",
      fromEnd: 1,
    });
  });

  test("agent preserves CLI session binding metadata when refreshing session state", async () => {
    await useTempSessionStorePath();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-cli",
          updatedAt: Date.now(),
          modelProvider: "claude-cli",
          model: "claude-opus-4-6",
          cliSessionIds: {
            "claude-cli": "cli-session-123",
          },
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "cli-session-123",
              authProfileId: "anthropic:work",
              mcpConfigHash: "mcp-config-hash",
              mcpResumeHash: "mcp-resume-hash",
            },
          },
          claudeCliSessionId: "cli-session-123",
        },
      },
    });

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      idempotencyKey: "idem-agent-cli-binding",
    });
    expect(res.ok).toBe(true);

    const sessionStorePath = testState.sessionStorePath;
    if (!sessionStorePath) {
      throw new Error("expected session store path");
    }
    const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
      string,
      {
        cliSessionBindings?: Record<string, unknown>;
        cliSessionIds?: Record<string, string>;
        claudeCliSessionId?: string;
      }
    >;
    expect(stored["agent:main:main"]?.cliSessionBindings).toEqual({
      "claude-cli": {
        sessionId: "cli-session-123",
        authProfileId: "anthropic:work",
        mcpConfigHash: "mcp-config-hash",
        mcpResumeHash: "mcp-resume-hash",
      },
    });
    expect(stored["agent:main:main"]?.cliSessionIds).toEqual({
      "claude-cli": "cli-session-123",
    });
    expect(stored["agent:main:main"]?.claudeCliSessionId).toBe("cli-session-123");
  });

  test("agent accepts built-in channel alias (imsg)", async () => {
    const registry = createRegistry([
      {
        pluginId: "imessage",
        source: "test",
        plugin: createStubChannelPlugin({ id: "imessage", label: "iMessage" }),
      },
      {
        pluginId: "msteams",
        source: "test",
        plugin: createMSTeamsPlugin({ aliases: ["teams"] }),
      },
    ]);
    setRegistry(registry);
    await writeMainSessionEntry({
      sessionId: "sess-alias",
      lastChannel: "imessage",
      lastTo: "chat_id:123",
    });
    const resIMessage = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "imsg",
      deliver: true,
      idempotencyKey: "idem-agent-imsg",
    });
    expect(resIMessage.ok).toBe(true);
    await vi.waitFor(() => {
      expect(vi.mocked(agentCommand)).toHaveBeenCalled();
    });
    expectAgentRoutingCall({ channel: "imessage", deliver: true, fromEnd: 1 });
  });

  test("agent accepts plugin channel alias (teams)", async () => {
    const registry = createRegistry([
      {
        pluginId: "msteams",
        source: "test",
        plugin: createMSTeamsPlugin({ aliases: ["teams"] }),
      },
    ]);
    setRegistry(registry);

    const resTeams = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "teams",
      to: "conversation:teams-abc",
      deliver: false,
      idempotencyKey: "idem-agent-teams",
    });
    expect(resTeams.ok).toBe(true);
    expectAgentRoutingCall({
      channel: "msteams",
      deliver: false,
      to: "conversation:teams-abc",
      fromEnd: 1,
    });
  });

  test("agent rejects unknown channel", async () => {
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "sms",
      idempotencyKey: "idem-agent-bad-channel",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
  });

  test("agent errors when deliver=true and last channel is webchat", async () => {
    testState.allowFrom = ["+1555"];
    await writeMainSessionEntry({
      sessionId: "sess-main-webchat",
      lastChannel: "webchat",
      lastTo: "+1555",
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      bestEffortDeliver: false,
      idempotencyKey: "idem-agent-webchat",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");
    expect(res.error?.message).toMatch(/Channel is required|runtime not initialized/);
    expect(vi.mocked(agentCommand)).not.toHaveBeenCalled();
  });

  test("agent downgrades to session-only delivery when best-effort is enabled and last channel is webchat", async () => {
    testState.allowFrom = ["+1555"];
    await writeMainSessionEntry({
      sessionId: "sess-main-webchat-best-effort",
      lastChannel: "webchat",
      lastTo: "+1555",
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      bestEffortDeliver: true,
      idempotencyKey: "idem-agent-webchat-best-effort",
    });
    expect(res.ok).toBe(true);
    expectAgentRoutingCall({ channel: "webchat", deliver: false });
  });

  test("agent downgrades to session-only when multiple channels are configured but no external target resolves", async () => {
    const registry = createRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: createConfiguredChannelPlugin({ id: "discord", label: "Discord" }),
      },
      {
        pluginId: "telegram",
        source: "test",
        plugin: createConfiguredChannelPlugin({ id: "telegram", label: "Telegram" }),
      },
    ]);
    setRegistry(registry);
    await writeMainSessionEntry({
      sessionId: "sess-main-multi-configured-best-effort",
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      bestEffortDeliver: true,
      idempotencyKey: "idem-agent-multi-configured-best-effort",
    });
    expect(res.ok).toBe(true);
    expectAgentRoutingCall({ channel: "webchat", deliver: false });
  });

  test("agent uses webchat for internal runs when last provider is webchat", async () => {
    await writeMainSessionEntry({
      sessionId: "sess-main-webchat-internal",
      lastChannel: "webchat",
      lastTo: "+1555",
    });
    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: false,
      idempotencyKey: "idem-agent-webchat-internal",
    });
    expect(res.ok).toBe(true);

    expectAgentRoutingCall({ channel: "webchat", deliver: false });
  });

  test("write-scoped callers cannot reset conversations via agent", async () => {
    await withGatewayServer(async ({ port }) => {
      await useTempSessionStorePath();
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("missing session store path");
      }

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main-before-write-reset",
            updatedAt: Date.now(),
          },
        },
      });

      const writeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      trackConnectChallengeNonce(writeWs);
      await new Promise<void>((resolve) => writeWs.once("open", resolve));
      await connectOk(writeWs, { scopes: ["operator.write"] });

      const directReset = await rpcReq(writeWs, "sessions.reset", { key: "main" });
      expect(directReset.ok).toBe(false);
      expect(directReset.error?.message).toContain("missing scope: operator.admin");

      vi.mocked(agentCommand).mockClear();
      const viaAgent = await rpcReq(writeWs, "agent", {
        message: "/reset",
        sessionKey: "main",
        idempotencyKey: "idem-agent-write-reset",
      });
      expect(viaAgent.ok).toBe(false);
      expect(viaAgent.error?.message).toContain("missing scope: operator.admin");

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(store["agent:main:main"]?.sessionId).toBeDefined();
      expect(store["agent:main:main"]?.sessionId).toBe("sess-main-before-write-reset");
      expect(vi.mocked(agentCommand)).not.toHaveBeenCalled();

      writeWs.close();
    });
  });

  test("agent ack response then final response", { timeout: 8000 }, async () => {
    const ackP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status === "accepted",
    );
    const finalP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
    );
    sendAgentWsRequest(ws, {
      reqId: "ag1",
      message: "hi",
      idempotencyKey: "idem-ag",
    });

    const ack = await ackP;
    const final = await finalP;
    const ackPayload = ack.payload;
    const finalPayload = final.payload;
    if (!ackPayload || !finalPayload) {
      throw new Error("missing websocket payload");
    }
    expect(ackPayload.runId).toBeDefined();
    expect(finalPayload.runId).toBe(ackPayload.runId);
    expect(finalPayload.status).toBe("ok");
  });

  test("agent dedupes by idempotencyKey after completion", async () => {
    const firstFinal = await sendAgentWsRequestAndWaitFinal(ws, {
      reqId: "ag1",
      message: "hi",
      idempotencyKey: "same-agent",
    });

    const secondP = onceMessage(ws, (o) => o.type === "res" && o.id === "ag2");
    sendAgentWsRequest(ws, {
      reqId: "ag2",
      message: "hi again",
      idempotencyKey: "same-agent",
    });
    const second = await secondP;
    expect(second.payload).toEqual(firstFinal.payload);
  });

  test("agent dedupe survives reconnect", { timeout: 20_000 }, async () => {
    await withGatewayServer(async ({ port }) => {
      const dial = async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        trackConnectChallengeNonce(ws);
        await new Promise<void>((resolve) => ws.once("open", resolve));
        await connectOk(ws);
        return ws;
      };

      const idem = "reconnect-agent";
      const ws1 = await dial();
      const final1 = await sendAgentWsRequestAndWaitFinal(ws1, {
        reqId: "ag1",
        message: "hi",
        idempotencyKey: idem,
        timeoutMs: 6000,
      });
      ws1.close();

      const ws2 = await dial();
      const res = await sendAgentWsRequestAndWaitFinal(ws2, {
        reqId: "ag2",
        message: "hi again",
        idempotencyKey: idem,
        timeoutMs: 6000,
      });
      expect(res.payload).toEqual(final1.payload);
      ws2.close();
    });
  });

  test("agent events stream to webchat clients when run context is registered", async () => {
    await writeMainSessionEntry({ sessionId: "sess-main" });

    const webchatWs = await connectWebchatClient({ port });

    registerAgentRunContext("run-auto-1", { sessionKey: "main" });

    const finalChatP = onceMessage(
      webchatWs,
      (o) => {
        if (o.type !== "event" || o.event !== "chat") {
          return false;
        }
        const payload = o.payload as { state?: unknown; runId?: unknown } | undefined;
        return payload?.state === "final" && payload.runId === "run-auto-1";
      },
      8000,
    );

    emitAgentEvent({
      runId: "run-auto-1",
      stream: "assistant",
      data: { text: "hi from agent" },
    });
    emitAgentEvent({
      runId: "run-auto-1",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    const evt = await finalChatP;
    const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
    expect(payload.sessionKey).toBe("main");
    expect(payload.runId).toBe("run-auto-1");

    webchatWs.close();
  });
});
