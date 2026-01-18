import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  agentCommand,
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startGatewayServer,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks();

const registryState = vi.hoisted(() => ({
  registry: {
    plugins: [],
    tools: [],
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
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

const _BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

function expectChannels(call: Record<string, unknown>, channel: string) {
  expect(call.channel).toBe(channel);
  expect(call.messageChannel).toBe(channel);
}

describe("gateway server agent", () => {
  beforeEach(() => {
    registryState.registry = emptyRegistry;
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    registryState.registry = emptyRegistry;
    setActivePluginRegistry(emptyRegistry);
  });

  test("agent routes main last-channel msteams", async () => {
    const registry = createRegistry([
      {
        pluginId: "msteams",
        source: "test",
        plugin: createMSTeamsPlugin(),
      },
    ]);
    registryState.registry = registry;
    setActivePluginRegistry(registry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-teams",
          updatedAt: Date.now(),
          lastChannel: "msteams",
          lastTo: "conversation:teams-123",
        },
      },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-msteams",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "msteams");
    expect(call.to).toBe("conversation:teams-123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-teams");

    ws.close();
    await server.close();
  });

  test("agent accepts channel aliases (imsg/teams)", async () => {
    const registry = createRegistry([
      {
        pluginId: "msteams",
        source: "test",
        plugin: createMSTeamsPlugin({ aliases: ["teams"] }),
      },
    ]);
    registryState.registry = registry;
    setActivePluginRegistry(registry);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-alias",
          updatedAt: Date.now(),
          lastChannel: "imessage",
          lastTo: "chat_id:123",
        },
      },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const resIMessage = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "imsg",
      deliver: true,
      idempotencyKey: "idem-agent-imsg",
    });
    expect(resIMessage.ok).toBe(true);

    const resTeams = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "teams",
      to: "conversation:teams-abc",
      deliver: false,
      idempotencyKey: "idem-agent-teams",
    });
    expect(resTeams.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const lastIMessageCall = spy.mock.calls.at(-2)?.[0] as Record<string, unknown>;
    expectChannels(lastIMessageCall, "imessage");
    expect(lastIMessageCall.to).toBe("chat_id:123");

    const lastTeamsCall = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(lastTeamsCall, "msteams");
    expect(lastTeamsCall.to).toBe("conversation:teams-abc");

    ws.close();
    await server.close();
  });

  test("agent rejects unknown channel", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "sms",
      idempotencyKey: "idem-agent-bad-channel",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("INVALID_REQUEST");

    ws.close();
    await server.close();
  });

  test("agent ignores webchat last-channel for routing", async () => {
    testState.allowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-webchat",
          updatedAt: Date.now(),
          lastChannel: "webchat",
          lastTo: "+1555",
        },
      },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: true,
      idempotencyKey: "idem-agent-webchat",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-webchat");

    ws.close();
    await server.close();
  });

  test("agent uses webchat for internal runs when last provider is webchat", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main-webchat-internal",
          updatedAt: Date.now(),
          lastChannel: "webchat",
          lastTo: "+1555",
        },
      },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      channel: "last",
      deliver: false,
      idempotencyKey: "idem-agent-webchat-internal",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectChannels(call, "webchat");
    expect(call.to).toBeUndefined();
    expect(call.deliver).toBe(false);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-webchat-internal");

    ws.close();
    await server.close();
  });

  test("agent ack response then final response", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const ackP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status === "accepted",
    );
    const finalP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "ag1",
        method: "agent",
        params: { message: "hi", idempotencyKey: "idem-ag" },
      }),
    );

    const ack = await ackP;
    const final = await finalP;
    expect(ack.payload.runId).toBeDefined();
    expect(final.payload.runId).toBe(ack.payload.runId);
    expect(final.payload.status).toBe("ok");

    ws.close();
    await server.close();
  });

  test("agent dedupes by idempotencyKey after completion", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const firstFinalP = onceMessage(
      ws,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
    );
    ws.send(
      JSON.stringify({
        type: "req",
        id: "ag1",
        method: "agent",
        params: { message: "hi", idempotencyKey: "same-agent" },
      }),
    );
    const firstFinal = await firstFinalP;

    const secondP = onceMessage(ws, (o) => o.type === "res" && o.id === "ag2");
    ws.send(
      JSON.stringify({
        type: "req",
        id: "ag2",
        method: "agent",
        params: { message: "hi again", idempotencyKey: "same-agent" },
      }),
    );
    const second = await secondP;
    expect(second.payload).toEqual(firstFinal.payload);

    ws.close();
    await server.close();
  });

  test("agent dedupe survives reconnect", { timeout: 60_000 }, async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);

    const dial = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise<void>((resolve) => ws.once("open", resolve));
      await connectOk(ws);
      return ws;
    };

    const idem = "reconnect-agent";
    const ws1 = await dial();
    const final1P = onceMessage(
      ws1,
      (o) => o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
      6000,
    );
    ws1.send(
      JSON.stringify({
        type: "req",
        id: "ag1",
        method: "agent",
        params: { message: "hi", idempotencyKey: idem },
      }),
    );
    const final1 = await final1P;
    ws1.close();

    const ws2 = await dial();
    const final2P = onceMessage(
      ws2,
      (o) => o.type === "res" && o.id === "ag2" && o.payload?.status !== "accepted",
      6000,
    );
    ws2.send(
      JSON.stringify({
        type: "req",
        id: "ag2",
        method: "agent",
        params: { message: "hi again", idempotencyKey: idem },
      }),
    );
    const res = await final2P;
    expect(res.payload).toEqual(final1.payload);
    ws2.close();
    await server.close();
  });

  test("agent events stream to webchat clients when run context is registered", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    registerAgentRunContext("run-auto-1", { sessionKey: "main" });

    const finalChatP = onceMessage(
      ws,
      (o) => {
        if (o.type !== "event" || o.event !== "chat") return false;
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
    const payload =
      evt.payload && typeof evt.payload === "object"
        ? (evt.payload as Record<string, unknown>)
        : {};
    expect(payload.sessionKey).toBe("main");
    expect(payload.runId).toBe("run-auto-1");

    ws.close();
    await server.close();
  });
});

const createRegistry = (channels: PluginRegistry["channels"]): PluginRegistry => ({
  plugins: [],
  tools: [],
  channels,
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  cliRegistrars: [],
  services: [],
  diagnostics: [],
});

const emptyRegistry = createRegistry([]);

const createMSTeamsPlugin = (params?: { aliases?: string[] }): ChannelPlugin => ({
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    blurb: "Bot Framework; enterprise support.",
    aliases: params?.aliases,
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
});
