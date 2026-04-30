import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { RequestFrame } from "./protocol/index.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createChatRunRegistry } from "./server-chat.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";
import type { GatewayClient as GatewayMethodClient } from "./server-methods/types.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { formatError, normalizeVoiceWakeTriggers } from "./server-utils.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeControlUiResponse() {
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  return { res };
}

const wsMockState = vi.hoisted(() => ({
  last: null as { url: unknown; opts: unknown } | null,
}));

vi.mock("ws", () => ({
  WebSocket: class MockWebSocket {
    on = vi.fn();
    close = vi.fn();
    send = vi.fn();

    constructor(url: unknown, opts: unknown) {
      wsMockState.last = { url, opts };
    }
  },
}));

let GatewayClient: typeof import("./client.js").GatewayClient;

describe("GatewayClient", () => {
  beforeAll(async () => {
    ({ GatewayClient } = await import("./client.js"));
  });

  beforeEach(() => {
    wsMockState.last = null;
  });

  async function withControlUiRoot(
    params: { faviconSvg?: string; indexHtml?: string },
    run: (tmp: string) => Promise<void>,
  ) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), params.indexHtml ?? "<html></html>\n");
      if (typeof params.faviconSvg === "string") {
        await fs.writeFile(path.join(tmp, "favicon.svg"), params.faviconSvg);
      }
      await run(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  test("uses a large maxPayload for node snapshots", () => {
    const client = new GatewayClient({ url: "ws://127.0.0.1:1" });
    client.start();
    const last = wsMockState.last as { url: unknown; opts: unknown } | null;

    expect(last?.url).toBe("ws://127.0.0.1:1");
    expect(last?.opts).toEqual(expect.objectContaining({ maxPayload: 25 * 1024 * 1024 }));
  });

  test("uses an explicit direct agent for control-plane WebSocket connections", () => {
    const client = new GatewayClient({ url: "ws://127.0.0.1:1" });
    client.start();
    const last = wsMockState.last as { opts: { agent?: unknown } } | null;

    expect(last?.opts.agent).toBeDefined();
    expect(last?.opts.agent).not.toBe(
      (global as unknown as { GLOBAL_AGENT?: { HTTP_PROXY?: unknown } }).GLOBAL_AGENT,
    );
  });

  test("uses an explicit direct agent for IPv6 loopback control-plane WebSocket connections", () => {
    const client = new GatewayClient({ url: "ws://[::1]:1" });
    client.start();
    const last = wsMockState.last as { opts: { agent?: unknown } } | null;

    expect(last?.opts.agent).toBeDefined();
  });

  test("uses the direct control-plane bypass for localhost hostnames", () => {
    const client = new GatewayClient({ url: "ws://localhost:1" });
    client.start();
    const last = wsMockState.last as { opts: { agent?: unknown } } | null;

    expect(last?.opts.agent).toBeDefined();
  });

  test("does not force a direct agent for remote Gateway WebSocket connections", () => {
    const client = new GatewayClient({
      url: "wss://gateway.example.com",
      tlsFingerprint: "SHA256:AA:BB",
    });
    client.start();
    const last = wsMockState.last as { opts: { agent?: unknown } } | null;

    expect(last?.opts.agent).toBeUndefined();
  });

  it("returns 404 for missing static asset paths instead of SPA fallback", async () => {
    await withControlUiRoot({ faviconSvg: "<svg/>" }, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/webchat/favicon.svg", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  it("returns 404 for missing static assets with query strings", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/webchat/favicon.svg?v=1", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  it("still serves SPA fallback for extensionless paths", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/webchat/chat", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  it("HEAD returns 404 for missing static assets consistent with GET", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/webchat/favicon.svg", method: "HEAD" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  it("serves SPA fallback for dotted path segments that are not static assets", async () => {
    await withControlUiRoot({}, async (tmp) => {
      for (const route of ["/webchat/user/jane.doe", "/webchat/v2.0", "/settings/v1.2"]) {
        const { res } = makeControlUiResponse();
        const handled = await handleControlUiHttpRequest(
          { url: route, method: "GET" } as IncomingMessage,
          res,
          { root: { kind: "resolved", path: tmp } },
        );
        expect(handled).toBe(true);
        expect(res.statusCode, `expected 200 for ${route}`).toBe(200);
      }
    });
  });

  it("serves SPA fallback for .html paths that do not exist on disk", async () => {
    await withControlUiRoot({}, async (tmp) => {
      const { res } = makeControlUiResponse();
      const handled = await handleControlUiHttpRequest(
        { url: "/webchat/foo.html", method: "GET" } as IncomingMessage,
        res,
        { root: { kind: "resolved", path: tmp } },
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });
});

type TestSocket = {
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code: number, reason: string) => void;
};

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type RecordingSocket = TestSocket & {
  sent: EventFrame[];
};

function makeRecordingSocket(): RecordingSocket {
  const sent: EventFrame[] = [];
  return {
    bufferedAmount: 0,
    send: vi.fn((payload: string) => {
      sent.push(JSON.parse(payload) as EventFrame);
    }),
    close: vi.fn(),
    sent,
  };
}

function makeGatewayWsClient(
  connId: string,
  socket: TestSocket,
  connect: GatewayWsClient["connect"],
): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect,
    connId,
    usesSharedGatewayAuth: false,
  };
}

function makeScopedBroadcastClients() {
  const pairingSocket = makeRecordingSocket();
  const nodeSocket = makeRecordingSocket();
  const readSocket = makeRecordingSocket();
  const writeSocket = makeRecordingSocket();
  const adminSocket = makeRecordingSocket();
  const clients = new Set<GatewayWsClient>([
    makeGatewayWsClient("c-pairing", pairingSocket, {
      role: "operator",
      scopes: ["operator.pairing"],
    } as GatewayWsClient["connect"]),
    makeGatewayWsClient("c-node", nodeSocket, {
      role: "node",
      scopes: ["operator.read"],
    } as GatewayWsClient["connect"]),
    makeGatewayWsClient("c-read", readSocket, {
      role: "operator",
      scopes: ["operator.read"],
    } as GatewayWsClient["connect"]),
    makeGatewayWsClient("c-write", writeSocket, {
      role: "operator",
      scopes: ["operator.write"],
    } as GatewayWsClient["connect"]),
    makeGatewayWsClient("c-admin", adminSocket, {
      role: "operator",
      scopes: ["operator.admin"],
    } as GatewayWsClient["connect"]),
  ]);

  return { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, clients };
}

describe("gateway broadcaster", () => {
  it("filters approval and pairing events by scope", () => {
    const approvalsSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const pairingSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const readSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };

    const clients = new Set<GatewayWsClient>([
      makeGatewayWsClient("c-approvals", approvalsSocket, {
        role: "operator",
        scopes: ["operator.approvals"],
      } as GatewayWsClient["connect"]),
      makeGatewayWsClient("c-pairing", pairingSocket, {
        role: "operator",
        scopes: ["operator.pairing"],
      } as GatewayWsClient["connect"]),
      makeGatewayWsClient("c-read", readSocket, {
        role: "operator",
        scopes: ["operator.read"],
      } as GatewayWsClient["connect"]),
    ]);

    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    broadcast("exec.approval.requested", { id: "1" });
    broadcast("device.pair.requested", { requestId: "r1" });

    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
    expect(readSocket.send).toHaveBeenCalledTimes(0);

    broadcastToConnIds("tick", { ts: 1 }, new Set(["c-read"]));
    expect(readSocket.send).toHaveBeenCalledTimes(1);
    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
  });

  it("requires operator.read for chat-class broadcast events", () => {
    const { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, clients } =
      makeScopedBroadcastClients();

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "agent:main:main", message: "secret" });
    broadcast("agent", { type: "status", sessionKey: "agent:main:main" });
    broadcast("chat.side_result", { sessionKey: "agent:main:main", text: "tool output" });

    expect(pairingSocket.send).not.toHaveBeenCalled();
    expect(nodeSocket.send).not.toHaveBeenCalled();
    expect(readSocket.send).toHaveBeenCalledTimes(3);
    expect(writeSocket.send).toHaveBeenCalledTimes(3);
    expect(adminSocket.send).toHaveBeenCalledTimes(3);
    expect(readSocket.sent.map((frame) => frame.event)).toEqual([
      "chat",
      "agent",
      "chat.side_result",
    ]);
    expect(writeSocket.sent.map((frame) => frame.event)).toEqual([
      "chat",
      "agent",
      "chat.side_result",
    ]);
    expect(adminSocket.sent.map((frame) => frame.event)).toEqual([
      "chat",
      "agent",
      "chat.side_result",
    ]);
  });

  it("allows plugin.* broadcast events for operator.write and operator.admin", () => {
    const { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, clients } =
      makeScopedBroadcastClients();

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("plugin.myplugin.custom", { data: "test" });
    broadcast("plugin.otherplugin.state", { state: "updated" });

    expect(pairingSocket.send).not.toHaveBeenCalled();
    expect(nodeSocket.send).not.toHaveBeenCalled();
    expect(readSocket.send).not.toHaveBeenCalled();
    expect(writeSocket.send).toHaveBeenCalledTimes(2);
    expect(adminSocket.send).toHaveBeenCalledTimes(2);
    expect(writeSocket.sent.map((frame) => frame.event)).toEqual([
      "plugin.myplugin.custom",
      "plugin.otherplugin.state",
    ]);
    expect(adminSocket.sent.map((frame) => frame.event)).toEqual([
      "plugin.myplugin.custom",
      "plugin.otherplugin.state",
    ]);
  });

  it("defaults unknown events to deny and classifies remaining gateway broadcast events", () => {
    const { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, clients } =
      makeScopedBroadcastClients();

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("cron", { jobId: "job-1" });
    broadcast("talk.mode", { enabled: true });
    broadcast("voicewake.changed", { triggers: ["hello"] });
    broadcast("voicewake.routing.changed", { config: { routes: [] } });
    broadcast("heartbeat", { ts: 1 });
    broadcast("presence", { presence: [] });
    broadcast("health", { ok: true });
    broadcast("tick", { ts: 2 });
    broadcast("shutdown", { reason: "restart" });
    broadcast("update.available", { updateAvailable: { version: "2026.4.20" } });
    broadcast("unknown.future.event", { hidden: true });

    expect(pairingSocket.sent.map((frame) => frame.event)).toEqual([
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ]);
    expect(nodeSocket.sent.map((frame) => frame.event)).toEqual([
      "voicewake.changed",
      "voicewake.routing.changed",
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ]);
    expect(readSocket.sent.map((frame) => frame.event)).toEqual([
      "cron",
      "voicewake.changed",
      "voicewake.routing.changed",
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ]);
    expect(writeSocket.sent.map((frame) => frame.event)).toEqual([
      "cron",
      "talk.mode",
      "voicewake.changed",
      "voicewake.routing.changed",
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ]);
    expect(adminSocket.sent.map((frame) => frame.event)).toEqual([
      "cron",
      "talk.mode",
      "voicewake.changed",
      "voicewake.routing.changed",
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ]);
  });

  it("keeps event seq contiguous per receiving client when scoped events are filtered", () => {
    const pairingSocket = makeRecordingSocket();
    const readSocket = makeRecordingSocket();

    const clients = new Set<GatewayWsClient>([
      makeGatewayWsClient("c-pairing", pairingSocket, {
        role: "operator",
        scopes: ["operator.pairing"],
      } as GatewayWsClient["connect"]),
      makeGatewayWsClient("c-read", readSocket, {
        role: "operator",
        scopes: ["operator.read"],
      } as GatewayWsClient["connect"]),
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "agent:main:main", message: "secret" });
    broadcast("heartbeat", { ts: 1 });
    broadcast("chat.side_result", { sessionKey: "agent:main:main", text: "tool output" });
    broadcast("tick", { ts: 2 });

    expect(pairingSocket.sent.map((frame) => [frame.event, frame.seq])).toEqual([
      ["heartbeat", 1],
      ["tick", 2],
    ]);
    expect(readSocket.sent.map((frame) => [frame.event, frame.seq])).toEqual([
      ["chat", 1],
      ["heartbeat", 2],
      ["chat.side_result", 3],
      ["tick", 4],
    ]);
  });

  it("preserves seq gaps when dropIfSlow skips an eligible broadcast", () => {
    const slowReadSocket = makeRecordingSocket();
    slowReadSocket.bufferedAmount = Number.MAX_SAFE_INTEGER;
    const readSocket = makeRecordingSocket();

    const clients = new Set<GatewayWsClient>([
      makeGatewayWsClient("c-slow-read", slowReadSocket, {
        role: "operator",
        scopes: ["operator.read"],
      } as GatewayWsClient["connect"]),
      makeGatewayWsClient("c-read", readSocket, {
        role: "operator",
        scopes: ["operator.read"],
      } as GatewayWsClient["connect"]),
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { sessionKey: "agent:main:main", message: "secret" }, { dropIfSlow: true });
    slowReadSocket.bufferedAmount = 0;
    broadcast("heartbeat", { ts: 1 });

    expect(slowReadSocket.sent.map((frame) => [frame.event, frame.seq])).toEqual([
      ["heartbeat", 2],
    ]);
    expect(readSocket.sent.map((frame) => [frame.event, frame.seq])).toEqual([
      ["chat", 1],
      ["heartbeat", 2],
    ]);
  });

  it("records a payload diagnostic when the outbound websocket buffer exceeds the limit", () => {
    resetDiagnosticEventsForTest();
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    try {
      const slowReadSocket = makeRecordingSocket();
      slowReadSocket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
      const clients = new Set<GatewayWsClient>([
        makeGatewayWsClient("c-slow-read", slowReadSocket, {
          role: "operator",
          scopes: ["operator.read"],
        } as GatewayWsClient["connect"]),
      ]);

      const { broadcast } = createGatewayBroadcaster({ clients });

      broadcast("chat", { sessionKey: "agent:main:main", message: "secret" }, { dropIfSlow: true });
      broadcast("heartbeat", { ts: 1 });

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "payload.large",
          surface: "gateway.ws.outbound_buffer",
          action: "rejected",
          bytes: MAX_BUFFERED_BYTES + 1,
          limitBytes: MAX_BUFFERED_BYTES,
          reason: "ws_send_buffer_drop",
        }),
      );
      expect(events.filter((event) => event.type === "payload.large")).toHaveLength(1);
    } finally {
      stop();
      resetDiagnosticEventsForTest();
    }
  });
});

describe("chat run registry", () => {
  test("queues and removes runs per session", () => {
    const registry = createChatRunRegistry();

    registry.add("s1", { sessionKey: "main", clientRunId: "c1" });
    registry.add("s1", { sessionKey: "main", clientRunId: "c2" });

    expect(registry.peek("s1")?.clientRunId).toBe("c1");
    expect(registry.shift("s1")?.clientRunId).toBe("c1");
    expect(registry.peek("s1")?.clientRunId).toBe("c2");

    expect(registry.remove("s1", "c2")?.clientRunId).toBe("c2");
    expect(registry.peek("s1")).toBeUndefined();
  });
});

describe("late-arriving invoke results", () => {
  test("returns success for unknown invoke ids for both success and error payloads", async () => {
    const nodeId = "node-123";
    const cases = [
      {
        id: "unknown-invoke-id-12345",
        ok: true,
        payloadJSON: JSON.stringify({ result: "late" }),
      },
      {
        id: "another-unknown-invoke-id",
        ok: false,
        error: { code: "FAILED", message: "test error" },
      },
    ] as const;

    for (const params of cases) {
      const respond = vi.fn<RespondFn>();
      const context = {
        nodeRegistry: { handleInvokeResult: () => false },
        logGateway: { debug: vi.fn() },
      } as unknown as GatewayRequestContext;
      const client = {
        connect: { device: { id: nodeId } },
      } as unknown as GatewayMethodClient;

      await handleNodeInvokeResult({
        req: { method: "node.invoke.result" } as unknown as RequestFrame,
        params: { ...params, nodeId } as unknown as Record<string, unknown>,
        client,
        isWebchatConnect: () => false,
        respond,
        context,
      });

      const [ok, rawPayload, error] = respond.mock.lastCall ?? [];
      const payload = rawPayload as { ok?: boolean; ignored?: boolean } | undefined;

      // Late-arriving results return success instead of error to reduce log noise.
      expect(ok).toBe(true);
      expect(error).toBeUndefined();
      expect(payload?.ok).toBe(true);
      expect(payload?.ignored).toBe(true);
    }
  });
});

describe("node subscription manager", () => {
  test("routes events to subscribed nodes", () => {
    const manager = createNodeSubscriptionManager();
    const sent: Array<{
      nodeId: string;
      event: string;
      payloadJSON?: string | null;
    }> = [];
    const sendEvent = (evt: { nodeId: string; event: string; payloadJSON?: string | null }) =>
      sent.push(evt);

    manager.subscribe("node-a", "main");
    manager.subscribe("node-b", "main");
    manager.sendToSession("main", "chat", { ok: true }, sendEvent);

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.nodeId).toSorted()).toEqual(["node-a", "node-b"]);
    expect(sent[0].event).toBe("chat");
  });

  test("unsubscribeAll clears session mappings", () => {
    const manager = createNodeSubscriptionManager();
    const sent: string[] = [];
    const sendEvent = (evt: { nodeId: string; event: string }) =>
      sent.push(`${evt.nodeId}:${evt.event}`);

    manager.subscribe("node-a", "main");
    manager.subscribe("node-a", "secondary");
    manager.unsubscribeAll("node-a");
    manager.sendToSession("main", "tick", {}, sendEvent);
    manager.sendToSession("secondary", "tick", {}, sendEvent);

    expect(sent).toEqual([]);
  });
});

describe("resolveNodeCommandAllowlist", () => {
  it("includes iOS service commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "ios 26.0",
        deviceFamily: "iPhone",
      },
    );

    expect(allow.has("device.info")).toBe(true);
    expect(allow.has("device.status")).toBe(true);
    expect(allow.has("system.notify")).toBe(true);
    expect(allow.has("contacts.search")).toBe(true);
    expect(allow.has("calendar.events")).toBe(true);
    expect(allow.has("reminders.list")).toBe(true);
    expect(allow.has("photos.latest")).toBe(true);
    expect(allow.has("motion.activity")).toBe(true);

    for (const cmd of DEFAULT_DANGEROUS_NODE_COMMANDS) {
      expect(allow.has(cmd)).toBe(false);
    }
  });

  it("includes Android notifications and device diagnostics commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "android 16",
        deviceFamily: "Android",
      },
    );

    expect(allow.has("notifications.list")).toBe(true);
    expect(allow.has("notifications.actions")).toBe(true);
    expect(allow.has("device.permissions")).toBe(true);
    expect(allow.has("device.health")).toBe(true);
    expect(allow.has("callLog.search")).toBe(true);
    expect(allow.has("system.notify")).toBe(true);
    expect(allow.has("sms.search")).toBe(false);
  });

  it("treats sms.search as dangerous by default", () => {
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).toContain("sms.search");
  });

  it("allows macOS screen.snapshot by default but keeps screen.record gated", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "macOS 26.3.1",
        deviceFamily: "Mac",
      },
    );

    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).not.toContain("screen.snapshot");
    expect(DEFAULT_DANGEROUS_NODE_COMMANDS).toContain("screen.record");
    expect(allow.has("screen.snapshot")).toBe(true);
    expect(allow.has("screen.record")).toBe(false);
  });

  it("allows safe Windows companion commands by default but keeps dangerous media gated", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "Windows_NT",
        deviceFamily: "Windows",
      },
    );

    expect(allow.has("canvas.present")).toBe(true);
    expect(allow.has("canvas.a2ui.pushJSONL")).toBe(true);
    expect(allow.has("camera.list")).toBe(true);
    expect(allow.has("location.get")).toBe(true);
    expect(allow.has("device.info")).toBe(true);
    expect(allow.has("device.status")).toBe(true);
    expect(allow.has("screen.snapshot")).toBe(true);
    expect(allow.has("system.run")).toBe(true);
    expect(allow.has("system.which")).toBe(true);
    expect(allow.has("system.notify")).toBe(true);

    for (const cmd of DEFAULT_DANGEROUS_NODE_COMMANDS) {
      expect(allow.has(cmd)).toBe(false);
    }
  });

  it("can explicitly allow dangerous commands via allowCommands", () => {
    const allow = resolveNodeCommandAllowlist(
      {
        gateway: {
          nodes: {
            allowCommands: ["camera.snap", "screen.record"],
          },
        },
      },
      { platform: "ios", deviceFamily: "iPhone" },
    );
    expect(allow.has("camera.snap")).toBe(true);
    expect(allow.has("screen.record")).toBe(true);
    expect(allow.has("camera.clip")).toBe(false);
  });

  it("treats unknown/confusable metadata as fail-safe for system.run defaults", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "iPhοne",
        deviceFamily: "iPhοne",
      },
    );

    expect(allow.has("system.run")).toBe(false);
    expect(allow.has("system.which")).toBe(false);
    expect(allow.has("system.notify")).toBe(true);
  });

  it("normalizes dotted-I platform values to iOS classification", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "İOS",
        deviceFamily: "iPhone",
      },
    );

    expect(allow.has("system.run")).toBe(false);
    expect(allow.has("system.which")).toBe(false);
    expect(allow.has("device.info")).toBe(true);
  });
});

describe("normalizeVoiceWakeTriggers", () => {
  test("returns defaults when input is empty", () => {
    expect(normalizeVoiceWakeTriggers([])).toEqual(defaultVoiceWakeTriggers());
    expect(normalizeVoiceWakeTriggers(null)).toEqual(defaultVoiceWakeTriggers());
  });

  test("trims and limits entries", () => {
    const result = normalizeVoiceWakeTriggers(["  hello  ", "", "world"]);
    expect(result).toEqual(["hello", "world"]);
  });
});

describe("formatError", () => {
  test("prefers message for Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  test("handles status/code", () => {
    expect(formatError({ status: 500, code: "EPIPE" })).toBe("status=500 code=EPIPE");
    expect(formatError({ status: 404 })).toBe("status=404 code=unknown");
    expect(formatError({ code: "ENOENT" })).toBe("status=unknown code=ENOENT");
  });
});
