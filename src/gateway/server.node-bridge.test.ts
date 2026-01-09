import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  agentCommand,
  bridgeInvoke,
  bridgeListConnected,
  bridgeSendEvent,
  bridgeStartCalls,
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
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

installGatewayTestHooks();

describe("gateway server node/bridge", () => {
  test("supports gateway-owned node pairing methods and events", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const requestedP = new Promise<{
      type: "event";
      event: string;
      payload?: unknown;
    }>((resolve) => {
      ws.on("message", (data) => {
        const obj = JSON.parse(decodeWsData(data)) as {
          type?: string;
          event?: string;
          payload?: unknown;
        };
        if (obj.type === "event" && obj.event === "node.pair.requested") {
          resolve(obj as never);
        }
      });
    });

    const res1 = await rpcReq(ws, "node.pair.request", {
      nodeId: "n1",
      displayName: "Node",
    });
    expect(res1.ok).toBe(true);
    const req1 = (res1.payload as { request?: { requestId?: unknown } } | null)
      ?.request;
    const requestId = typeof req1?.requestId === "string" ? req1.requestId : "";
    expect(requestId.length).toBeGreaterThan(0);

    const evt1 = await requestedP;
    expect(evt1.event).toBe("node.pair.requested");
    expect((evt1.payload as { requestId?: unknown } | null)?.requestId).toBe(
      requestId,
    );

    const res2 = await rpcReq(ws, "node.pair.request", {
      nodeId: "n1",
      displayName: "Node",
    });
    expect(res2.ok).toBe(true);
    await expect(
      onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "node.pair.requested",
        200,
      ),
    ).rejects.toThrow();

    const resolvedP = new Promise<{
      type: "event";
      event: string;
      payload?: unknown;
    }>((resolve) => {
      ws.on("message", (data) => {
        const obj = JSON.parse(decodeWsData(data)) as {
          type?: string;
          event?: string;
          payload?: unknown;
        };
        if (obj.type === "event" && obj.event === "node.pair.resolved") {
          resolve(obj as never);
        }
      });
    });

    const approveRes = await rpcReq(ws, "node.pair.approve", { requestId });
    expect(approveRes.ok).toBe(true);
    const tokenValue = (
      approveRes.payload as { node?: { token?: unknown } } | null
    )?.node?.token;
    const token = typeof tokenValue === "string" ? tokenValue : "";
    expect(token.length).toBeGreaterThan(0);

    const evt2 = await resolvedP;
    expect((evt2.payload as { requestId?: unknown } | null)?.requestId).toBe(
      requestId,
    );
    expect((evt2.payload as { decision?: unknown } | null)?.decision).toBe(
      "approved",
    );

    const verifyRes = await rpcReq(ws, "node.pair.verify", {
      nodeId: "n1",
      token,
    });
    expect(verifyRes.ok).toBe(true);
    expect((verifyRes.payload as { ok?: unknown } | null)?.ok).toBe(true);

    const listRes = await rpcReq(ws, "node.pair.list", {});
    expect(listRes.ok).toBe(true);
    const paired = (listRes.payload as { paired?: unknown } | null)?.paired;
    expect(Array.isArray(paired)).toBe(true);
    expect(
      (paired as Array<{ nodeId?: unknown }>).some((n) => n.nodeId === "n1"),
    ).toBe(true);

    ws.close();
    await server.close();
    await fs.rm(homeDir, { recursive: true, force: true });
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  test("routes node.invoke to the node bridge", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      bridgeInvoke.mockResolvedValueOnce({
        type: "invoke-res",
        id: "inv-1",
        ok: true,
        payloadJSON: JSON.stringify({ result: "4" }),
        error: null,
      });

      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const res = await rpcReq(ws, "node.invoke", {
          nodeId: "ios-node",
          command: "canvas.eval",
          params: { javaScript: "2+2" },
          timeoutMs: 123,
          idempotencyKey: "idem-1",
        });
        expect(res.ok).toBe(true);

        expect(bridgeInvoke).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: "ios-node",
            command: "canvas.eval",
            paramsJSON: JSON.stringify({ javaScript: "2+2" }),
            timeoutMs: 123,
          }),
        );
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("routes camera.list invoke to the node bridge", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      bridgeInvoke.mockResolvedValueOnce({
        type: "invoke-res",
        id: "inv-2",
        ok: true,
        payloadJSON: JSON.stringify({ devices: [] }),
        error: null,
      });

      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const res = await rpcReq(ws, "node.invoke", {
          nodeId: "ios-node",
          command: "camera.list",
          params: {},
          idempotencyKey: "idem-2",
        });
        expect(res.ok).toBe(true);

        expect(bridgeInvoke).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: "ios-node",
            command: "camera.list",
            paramsJSON: JSON.stringify({}),
          }),
        );
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.describe returns supported invoke commands for paired nodes", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const reqRes = await rpcReq<{
          status?: string;
          request?: { requestId?: string };
        }>(ws, "node.pair.request", {
          nodeId: "n1",
          displayName: "iPad",
          platform: "iPadOS",
          version: "dev",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas", "camera"],
          commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
          remoteIp: "10.0.0.10",
        });
        expect(reqRes.ok).toBe(true);
        const requestId = reqRes.payload?.request?.requestId;
        expect(typeof requestId).toBe("string");

        const approveRes = await rpcReq(ws, "node.pair.approve", {
          requestId,
        });
        expect(approveRes.ok).toBe(true);

        const describeRes = await rpcReq<{ commands?: string[] }>(
          ws,
          "node.describe",
          { nodeId: "n1" },
        );
        expect(describeRes.ok).toBe(true);
        expect(describeRes.payload?.commands).toEqual([
          "camera.snap",
          "canvas.eval",
          "canvas.snapshot",
        ]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.describe works for connected unpaired nodes (caps + commands)", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        bridgeListConnected.mockReturnValueOnce([
          {
            nodeId: "u1",
            displayName: "Unpaired Live",
            platform: "Android",
            version: "dev-live",
            remoteIp: "10.0.0.12",
            deviceFamily: "Android",
            modelIdentifier: "samsung SM-X926B",
            caps: ["canvas", "camera", "canvas"],
            commands: ["canvas.eval", "camera.snap", "canvas.eval"],
          },
        ]);

        const describeRes = await rpcReq<{
          paired?: boolean;
          connected?: boolean;
          caps?: string[];
          commands?: string[];
          deviceFamily?: string;
          modelIdentifier?: string;
          remoteIp?: string;
        }>(ws, "node.describe", { nodeId: "u1" });
        expect(describeRes.ok).toBe(true);
        expect(describeRes.payload).toMatchObject({
          paired: false,
          connected: true,
          deviceFamily: "Android",
          modelIdentifier: "samsung SM-X926B",
          remoteIp: "10.0.0.12",
        });
        expect(describeRes.payload?.caps).toEqual(["camera", "canvas"]);
        expect(describeRes.payload?.commands).toEqual([
          "camera.snap",
          "canvas.eval",
        ]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.list includes connected unpaired nodes with capabilities + commands", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const reqRes = await rpcReq<{
          status?: string;
          request?: { requestId?: string };
        }>(ws, "node.pair.request", {
          nodeId: "p1",
          displayName: "Paired",
          platform: "iPadOS",
          version: "dev",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas"],
          commands: ["canvas.eval"],
          remoteIp: "10.0.0.10",
        });
        expect(reqRes.ok).toBe(true);
        const requestId = reqRes.payload?.request?.requestId;
        expect(typeof requestId).toBe("string");

        const approveRes = await rpcReq(ws, "node.pair.approve", { requestId });
        expect(approveRes.ok).toBe(true);

        bridgeListConnected.mockReturnValueOnce([
          {
            nodeId: "p1",
            displayName: "Paired Live",
            platform: "iPadOS",
            version: "dev-live",
            remoteIp: "10.0.0.11",
            deviceFamily: "iPad",
            modelIdentifier: "iPad16,6",
            caps: ["canvas", "camera"],
            commands: ["canvas.snapshot", "canvas.eval"],
          },
          {
            nodeId: "u1",
            displayName: "Unpaired Live",
            platform: "Android",
            version: "dev",
            remoteIp: "10.0.0.12",
            deviceFamily: "Android",
            modelIdentifier: "samsung SM-X926B",
            caps: ["canvas"],
            commands: ["canvas.eval"],
          },
        ]);

        const listRes = await rpcReq<{
          nodes?: Array<{
            nodeId: string;
            paired?: boolean;
            connected?: boolean;
            caps?: string[];
            commands?: string[];
            displayName?: string;
            remoteIp?: string;
          }>;
        }>(ws, "node.list", {});
        expect(listRes.ok).toBe(true);
        const nodes = listRes.payload?.nodes ?? [];

        const pairedNode = nodes.find((n) => n.nodeId === "p1");
        expect(pairedNode).toMatchObject({
          nodeId: "p1",
          paired: true,
          connected: true,
          displayName: "Paired Live",
          remoteIp: "10.0.0.11",
        });
        expect(pairedNode?.caps?.slice().sort()).toEqual(["camera", "canvas"]);
        expect(pairedNode?.commands?.slice().sort()).toEqual([
          "canvas.eval",
          "canvas.snapshot",
        ]);

        const unpairedNode = nodes.find((n) => n.nodeId === "u1");
        expect(unpairedNode).toMatchObject({
          nodeId: "u1",
          paired: false,
          connected: true,
          displayName: "Unpaired Live",
        });
        expect(unpairedNode?.caps).toEqual(["canvas"]);
        expect(unpairedNode?.commands).toEqual(["canvas.eval"]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("emits presence updates for bridge connect/disconnect", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      const before = bridgeStartCalls.length;
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);
        const bridgeCall = bridgeStartCalls[before];
        expect(bridgeCall).toBeTruthy();

        const waitPresenceReason = async (reason: string) => {
          await onceMessage(
            ws,
            (o) => {
              if (o.type !== "event" || o.event !== "presence") return false;
              const payload = o.payload as { presence?: unknown } | null;
              const list = payload?.presence;
              if (!Array.isArray(list)) return false;
              return list.some(
                (p) =>
                  typeof p === "object" &&
                  p !== null &&
                  (p as { instanceId?: unknown }).instanceId === "node-1" &&
                  (p as { reason?: unknown }).reason === reason,
              );
            },
            3000,
          );
        };

        const presenceConnectedP = waitPresenceReason("node-connected");
        await bridgeCall?.onAuthenticated?.({
          nodeId: "node-1",
          displayName: "Node",
          platform: "ios",
          version: "1.0",
          remoteIp: "10.0.0.10",
        });
        await presenceConnectedP;

        const presenceDisconnectedP = waitPresenceReason("node-disconnected");
        await bridgeCall?.onDisconnected?.({
          nodeId: "node-1",
          displayName: "Node",
          platform: "ios",
          version: "1.0",
          remoteIp: "10.0.0.10",
        });
        await presenceDisconnectedP;
      } finally {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        await server.close();
        await fs.rm(homeDir, { recursive: true, force: true });
      }
    } finally {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("bridge RPC chat.history returns session messages", async () => {
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

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "hi" }],
            timestamp: Date.now(),
          },
        }),
      ].join("\n"),
      "utf-8",
    );

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onRequest).toBeDefined();

    const res = await bridgeCall?.onRequest?.("ios-node", {
      id: "r1",
      method: "chat.history",
      paramsJSON: JSON.stringify({ sessionKey: "main" }),
    });

    expect(res?.ok).toBe(true);
    const payload = JSON.parse(
      String((res as { payloadJSON?: string }).payloadJSON ?? "{}"),
    ) as {
      sessionKey?: string;
      sessionId?: string;
      messages?: unknown[];
    };
    expect(payload.sessionKey).toBe("main");
    expect(payload.sessionId).toBe("sess-main");
    expect(Array.isArray(payload.messages)).toBe(true);
    expect(payload.messages?.length).toBeGreaterThan(0);

    await server.close();
  });

  test("bridge RPC sessions.list returns session rows", async () => {
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

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onRequest).toBeDefined();

    const res = await bridgeCall?.onRequest?.("ios-node", {
      id: "r1",
      method: "sessions.list",
      paramsJSON: JSON.stringify({
        includeGlobal: true,
        includeUnknown: false,
        limit: 50,
      }),
    });

    expect(res?.ok).toBe(true);
    const payload = JSON.parse(
      String((res as { payloadJSON?: string }).payloadJSON ?? "{}"),
    ) as {
      sessions?: unknown[];
      count?: number;
      path?: string;
    };
    expect(Array.isArray(payload.sessions)).toBe(true);
    expect(typeof payload.count).toBe("number");
    expect(typeof payload.path).toBe("string");

    const resolveRes = await bridgeCall?.onRequest?.("ios-node", {
      id: "r2",
      method: "sessions.resolve",
      paramsJSON: JSON.stringify({ key: "main" }),
    });
    expect(resolveRes?.ok).toBe(true);
    const resolvedPayload = JSON.parse(
      String((resolveRes as { payloadJSON?: string }).payloadJSON ?? "{}"),
    ) as { key?: string };
    expect(resolvedPayload.key).toBe("agent:main:main");

    await server.close();
  });

  test("bridge chat events are pushed to subscribed nodes", async () => {
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

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const bridgeCall = bridgeStartCalls.at(-1);
    expect(bridgeCall?.onEvent).toBeDefined();
    expect(bridgeCall?.onRequest).toBeDefined();

    await bridgeCall?.onEvent?.("ios-node", {
      event: "chat.subscribe",
      payloadJSON: JSON.stringify({ sessionKey: "main" }),
    });

    bridgeSendEvent.mockClear();

    const reqRes = await bridgeCall?.onRequest?.("ios-node", {
      id: "s1",
      method: "chat.send",
      paramsJSON: JSON.stringify({
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-bridge-chat",
        timeoutMs: 30_000,
      }),
    });
    expect(reqRes?.ok).toBe(true);

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

    await new Promise((r) => setTimeout(r, 25));

    expect(bridgeSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-node",
        event: "agent",
      }),
    );

    expect(bridgeSendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-node",
        event: "chat",
      }),
    );

    await server.close();
  });

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
            lastProvider: "whatsapp",
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
    expect(call.messageProvider).toBe("node");

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
        name: "webchat",
        version: "1.0.0",
        platform: "test",
        mode: "webchat",
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
