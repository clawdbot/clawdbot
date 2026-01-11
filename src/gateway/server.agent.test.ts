import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import {
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-provider.js";
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
} from "./test-helpers.js";

installGatewayTestHooks();

const BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

function expectProviders(call: Record<string, unknown>, provider: string) {
  expect(call.provider).toBe(provider);
  expect(call.messageProvider).toBe(provider);
}

describe("gateway server agent", () => {
  test("agent marks implicit delivery when lastTo is stale", async () => {
    testState.allowFrom = ["+436769770569"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-stale",
            updatedAt: Date.now(),
            lastProvider: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-stale",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliveryTargetMode).toBe("implicit");
    expect(call.sessionId).toBe("sess-main-stale");

    ws.close();
    await server.close();
    testState.allowFrom = undefined;
  });

  test("agent forwards sessionKey to agentCommand", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          "agent:main:subagent:abc": {
            sessionId: "sess-sub",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

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
    expectProviders(call, "webchat");
    expect(call.deliver).toBe(false);
    expect(call.to).toBeUndefined();

    ws.close();
    await server.close();
  });

  test("agent forwards image attachments as images[]", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-images",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

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
    expectProviders(call, "webchat");
    expect(call.message).toBe("what is in the image?");

    const images = call.images as Array<Record<string, unknown>>;
    expect(Array.isArray(images)).toBe(true);
    expect(images.length).toBe(1);
    expect(images[0]?.type).toBe("image");
    expect(images[0]?.mimeType).toBe("image/png");
    expect(images[0]?.data).toBe(BASE_IMAGE_PNG);

    ws.close();
    await server.close();
  });

  test("agent falls back to whatsapp when delivery requested and no last provider exists", async () => {
    testState.allowFrom = ["+1555"];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-missing-provider",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      deliver: true,
      idempotencyKey: "idem-agent-missing-provider",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-missing-provider");

    ws.close();
    await server.close();
    testState.allowFrom = undefined;
  });

  test("agent routes main last-channel whatsapp", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-whatsapp",
            updatedAt: Date.now(),
            lastProvider: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-whatsapp",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "whatsapp");
    expect(call.messageProvider).toBe("whatsapp");
    expect(call.to).toBe("+1555");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-whatsapp");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel telegram", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastProvider: "telegram",
            lastTo: "123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "telegram");
    expect(call.to).toBe("123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel discord", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            lastProvider: "discord",
            lastTo: "channel:discord-123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-discord",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "discord");
    expect(call.to).toBe("channel:discord-123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-discord");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel slack", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-slack",
            updatedAt: Date.now(),
            lastProvider: "slack",
            lastTo: "channel:slack-123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-slack",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "slack");
    expect(call.to).toBe("channel:slack-123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-slack");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel signal", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-signal",
            updatedAt: Date.now(),
            lastProvider: "signal",
            lastTo: "+15551234567",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-signal",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "signal");
    expect(call.to).toBe("+15551234567");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-signal");

    ws.close();
    await server.close();
  });

  test("agent routes main last-channel msteams", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-teams",
            updatedAt: Date.now(),
            lastProvider: "msteams",
            lastTo: "conversation:teams-123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-last-msteams",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "msteams");
    expect(call.to).toBe("conversation:teams-123");
    expect(call.deliver).toBe(true);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-teams");

    ws.close();
    await server.close();
  });

  test("agent accepts provider aliases (imsg/teams)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-alias",
            updatedAt: Date.now(),
            lastProvider: "imessage",
            lastTo: "chat_id:123",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const resIMessage = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "imsg",
      deliver: true,
      idempotencyKey: "idem-agent-imsg",
    });
    expect(resIMessage.ok).toBe(true);

    const resTeams = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "teams",
      to: "conversation:teams-abc",
      deliver: false,
      idempotencyKey: "idem-agent-teams",
    });
    expect(resTeams.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const lastIMessageCall = spy.mock.calls.at(-2)?.[0] as Record<
      string,
      unknown
    >;
    expectProviders(lastIMessageCall, "imessage");
    expect(lastIMessageCall.to).toBe("chat_id:123");

    const lastTeamsCall = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(lastTeamsCall, "msteams");
    expect(lastTeamsCall.to).toBe("conversation:teams-abc");

    ws.close();
    await server.close();
  });

  test("agent rejects unknown provider", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "sms",
      idempotencyKey: "idem-agent-bad-provider",
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
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-webchat",
            updatedAt: Date.now(),
            lastProvider: "webchat",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: true,
      idempotencyKey: "idem-agent-webchat",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "whatsapp");
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
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main-webchat-internal",
            updatedAt: Date.now(),
            lastProvider: "webchat",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      message: "hi",
      sessionKey: "main",
      provider: "last",
      deliver: false,
      idempotencyKey: "idem-agent-webchat-internal",
    });
    expect(res.ok).toBe(true);

    const spy = vi.mocked(agentCommand);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expectProviders(call, "webchat");
    expect(call.to).toBeUndefined();
    expect(call.deliver).toBe(false);
    expect(call.bestEffortDeliver).toBe(true);
    expect(call.sessionId).toBe("sess-main-webchat-internal");

    ws.close();
    await server.close();
  });

  test(
    "agent ack response then final response",
    { timeout: 8000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const ackP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status === "accepted",
      );
      const finalP = onceMessage(
        ws,
        (o) =>
          o.type === "res" &&
          o.id === "ag1" &&
          o.payload?.status !== "accepted",
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
    },
  );

  test("agent dedupes by idempotencyKey after completion", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const firstFinalP = onceMessage(
      ws,
      (o) =>
        o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
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

  test("agent dedupe survives reconnect", { timeout: 15000 }, async () => {
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
      (o) =>
        o.type === "res" && o.id === "ag1" && o.payload?.status !== "accepted",
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
      (o) =>
        o.type === "res" && o.id === "ag2" && o.payload?.status !== "accepted",
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
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

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
        const payload = o.payload as
          | { state?: unknown; runId?: unknown }
          | undefined;
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

  test("agent events include sessionKey in agent payloads", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    registerAgentRunContext("run-tool-1", {
      sessionKey: "main",
      verboseLevel: "on",
    });

    const agentEvtP = onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "agent" &&
        o.payload?.runId === "run-tool-1",
      8000,
    );

    emitAgentEvent({
      runId: "run-tool-1",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tool-1" },
    });

    const evt = await agentEvtP;
    const payload =
      evt.payload && typeof evt.payload === "object"
        ? (evt.payload as Record<string, unknown>)
        : {};
    expect(payload.sessionKey).toBe("main");

    ws.close();
    await server.close();
  });

  test("suppresses tool stream events when verbose is off", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            verboseLevel: "off",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "agent:main:main" });

    emitAgentEvent({
      runId: "run-tool-off",
      stream: "tool",
      data: { phase: "start", name: "read", toolCallId: "tool-1" },
    });
    emitAgentEvent({
      runId: "run-tool-off",
      stream: "assistant",
      data: { text: "hello" },
    });

    const evt = await onceMessage(
      ws,
      (o) =>
        o.type === "event" &&
        o.event === "agent" &&
        o.payload?.runId === "run-tool-off",
      8000,
    );
    const payload =
      evt.payload && typeof evt.payload === "object"
        ? (evt.payload as Record<string, unknown>)
        : {};
    expect(payload.stream).toBe("assistant");

    ws.close();
    await server.close();
  });

  test("agent.wait resolves after lifecycle end", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const waitP = rpcReq(ws, "agent.wait", {
      runId: "run-wait-1",
      timeoutMs: 1000,
    });

    setTimeout(() => {
      emitAgentEvent({
        runId: "run-wait-1",
        stream: "lifecycle",
        data: { phase: "end", startedAt: 200, endedAt: 210 },
      });
    }, 10);

    const res = await waitP;
    expect(res.ok).toBe(true);
    expect(res.payload.status).toBe("ok");
    expect(res.payload.startedAt).toBe(200);

    ws.close();
    await server.close();
  });

  test("agent.wait resolves when lifecycle ended before wait call", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    emitAgentEvent({
      runId: "run-wait-early",
      stream: "lifecycle",
      data: { phase: "end", startedAt: 50, endedAt: 55 },
    });

    const res = await rpcReq(ws, "agent.wait", {
      runId: "run-wait-early",
      timeoutMs: 1000,
    });
    expect(res.ok).toBe(true);
    expect(res.payload.status).toBe("ok");
    expect(res.payload.startedAt).toBe(50);

    ws.close();
    await server.close();
  });

  test("agent.wait times out when no lifecycle ends", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent.wait", {
      runId: "run-wait-3",
      timeoutMs: 20,
    });
    expect(res.ok).toBe(true);
    expect(res.payload.status).toBe("timeout");

    ws.close();
    await server.close();
  });

  test("agent.wait returns error on lifecycle error", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const waitP = rpcReq(ws, "agent.wait", {
      runId: "run-wait-err",
      timeoutMs: 1000,
    });

    setTimeout(() => {
      emitAgentEvent({
        runId: "run-wait-err",
        stream: "lifecycle",
        data: { phase: "error", error: "boom" },
      });
    }, 10);

    const res = await waitP;
    expect(res.ok).toBe(true);
    expect(res.payload.status).toBe("error");
    expect(res.payload.error).toBe("boom");

    ws.close();
    await server.close();
  });

  test("agent.wait uses lifecycle start timestamp when end omits it", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const waitP = rpcReq(ws, "agent.wait", {
      runId: "run-wait-start",
      timeoutMs: 1000,
    });

    emitAgentEvent({
      runId: "run-wait-start",
      stream: "lifecycle",
      data: { phase: "start", startedAt: 123 },
    });

    setTimeout(() => {
      emitAgentEvent({
        runId: "run-wait-start",
        stream: "lifecycle",
        data: { phase: "end", endedAt: 456 },
      });
    }, 10);

    const res = await waitP;
    expect(res.ok).toBe(true);
    expect(res.payload.status).toBe("ok");
    expect(res.payload.startedAt).toBe(123);
    expect(res.payload.endedAt).toBe(456);

    ws.close();
    await server.close();
  });
});
