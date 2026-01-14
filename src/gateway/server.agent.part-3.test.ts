import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

const _BASE_IMAGE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

function _expectChannels(call: Record<string, unknown>, channel: string) {
  expect(call.channel).toBe(channel);
  expect(call.messageChannel).toBe(channel);
}

describe("gateway server agent", () => {
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
