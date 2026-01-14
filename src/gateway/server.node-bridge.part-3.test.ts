import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import {
  agentCommand,
  bridgeStartCalls,
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  sessionStoreSaveDelayMs,
  startGatewayServer,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

const decodeWsData = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf-8",
    );
  }
  return "";
};

async function _waitFor(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

installGatewayTestHooks();

describe("gateway server node/bridge", () => {
  test("bridge voice transcript defaults to main session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onEvent).toBeDefined();

    const spy = vi.mocked(agentCommand);
    const beforeCalls = spy.mock.calls.length;

    await bridgeCall?.onEvent?.("ios-node", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({ text: "hello" }),
    });

    expect(spy.mock.calls.length).toBe(beforeCalls + 1);
    const call = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(call.sessionId).toBe("sess-main");
    expect(call.sessionKey).toBe("main");
    expect(call.deliver).toBe(false);
    expect(call.messageChannel).toBe("node");

    const stored = JSON.parse(
      await fs.readFile(testState.sessionStorePath, "utf-8"),
    ) as Record<string, { sessionId?: string } | undefined>;
    expect(stored.main?.sessionId).toBe("sess-main");
    expect(stored["node-ios-node"]).toBeUndefined();

    await server.close();
  });

  test("bridge voice transcript triggers chat events for webchat clients", async () => {
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

    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onEvent).toBeDefined();

    const isVoiceFinalChatEvent = (o: unknown) => {
      if (!o || typeof o !== "object") return false;
      const rec = o as Record<string, unknown>;
      if (rec.type !== "event" || rec.event !== "chat") return false;
      if (!rec.payload || typeof rec.payload !== "object") return false;
      const payload = rec.payload as Record<string, unknown>;
      const runId = typeof payload.runId === "string" ? payload.runId : "";
      const state = typeof payload.state === "string" ? payload.state : "";
      return runId.startsWith("voice-") && state === "final";
    };

    const finalChatP = new Promise<{
      type: "event";
      event: string;
      payload?: unknown;
    }>((resolve) => {
      ws.on("message", (data) => {
        const obj = JSON.parse(decodeWsData(data));
        if (isVoiceFinalChatEvent(obj)) {
          resolve(obj as never);
        }
      });
    });

    await bridgeCall?.onEvent?.("ios-node", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({ text: "hello", sessionKey: "main" }),
    });

    emitAgentEvent({
      runId: "sess-main",
      seq: 1,
      ts: Date.now(),
      stream: "assistant",
      data: { text: "hi from agent" },
    });
    emitAgentEvent({
      runId: "sess-main",
      seq: 2,
      ts: Date.now(),
      stream: "lifecycle",
      data: { phase: "end" },
    });

    const evt = await finalChatP;
    const payload =
      evt.payload && typeof evt.payload === "object"
        ? (evt.payload as Record<string, unknown>)
        : {};
    expect(payload.sessionKey).toBe("main");
    const message =
      payload.message && typeof payload.message === "object"
        ? (payload.message as Record<string, unknown>)
        : {};
    expect(message.role).toBe("assistant");

    ws.close();
    await server.close();
  });

  test("bridge chat.abort cancels while saving the session store", async () => {
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

    sessionStoreSaveDelayMs.value = 120;

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onRequest).toBeDefined();

    const spy = vi.mocked(agentCommand);
    spy.mockImplementationOnce(async (opts) => {
      const signal = (opts as { abortSignal?: AbortSignal }).abortSignal;
      await new Promise<void>((resolve) => {
        if (!signal) return resolve();
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });

    const sendP = bridgeCall?.onRequest?.("ios-node", {
      id: "send-abort-save-bridge-1",
      method: "chat.send",
      paramsJSON: JSON.stringify({
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-save-bridge-1",
        timeoutMs: 30_000,
      }),
    });

    const abortRes = await bridgeCall?.onRequest?.("ios-node", {
      id: "abort-save-bridge-1",
      method: "chat.abort",
      paramsJSON: JSON.stringify({
        sessionKey: "main",
        runId: "idem-abort-save-bridge-1",
      }),
    });

    expect(abortRes?.ok).toBe(true);

    const sendRes = await sendP;
    expect(sendRes?.ok).toBe(true);

    await server.close();
  });
});
