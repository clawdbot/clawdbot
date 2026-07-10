// Gateway miscellaneous tests cover shared utility edges around control UI,
// diagnostics, proxy state, node command policy, and server helper behavior.
import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, test, vi } from "vitest";
import type { RequestFrame } from "../../packages/gateway-protocol/src/index.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "../infra/net/proxy/active-proxy-state.js";
import { defaultVoiceWakeTriggers } from "../infra/voicewake.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { SerializedEventPayload } from "./node-registry.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createChatRunRegistry } from "./server-chat.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { handleNodeInvokeResult } from "./server-methods/nodes.handlers.invoke-result.js";
import type { GatewayClient as GatewayMethodClient } from "./server-methods/types.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
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
  last: null as {
    url: unknown;
    opts: unknown;
    noProxyDuringConstruction: unknown;
    httpProxyDuringConstruction: unknown;
    httpsProxyDuringConstruction: unknown;
  } | null,
}));

vi.mock("ws", () => ({
  WebSocket: class MockWebSocket {
    on = vi.fn();
    close = vi.fn();
    send = vi.fn();

    constructor(url: unknown, opts: unknown) {
      wsMockState.last = {
        url,
        opts,
        noProxyDuringConstruction: process.env["NO_PROXY"],
        httpProxyDuringConstruction: process.env["HTTP_PROXY"],
        httpsProxyDuringConstruction: process.env["HTTPS_PROXY"],
      };
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
    resetActiveManagedProxyStateForTests();
    delete process.env["NO_PROXY"];
    delete process.env["no_proxy"];
    delete process.env["HTTP_PROXY"];
    delete process.env["HTTPS_PROXY"];
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

  async function expectControlUiStatus(
    tmp: string,
    params: { url: string; method?: string; statusCode: number },
  ) {
    const { res } = makeControlUiResponse();
    const handled = await handleControlUiHttpRequest(
      { url: params.url, method: params.method ?? "GET" } as IncomingMessage,
      res,
      { root: { kind: "resolved", path: tmp } },
    );
    expect(handled).toBe(true);
    expect(res.statusCode, `expected ${params.statusCode} for ${params.url}`).toBe(
      params.statusCode,
    );
  }

  function startGatewayClient(params: { url: string; tlsFingerprint?: string }) {
    const client = new GatewayClient(params);
    client.start();
    return wsMockState.last;
  }

  function expectNoGatewayClientAgent(params: { url: string; tlsFingerprint?: string }) {
    const last = startGatewayClient(params) as { opts: { agent?: unknown } } | null;
    expect(last?.opts.agent).toBeUndefined();
  }

  function setCorporateNoProxy() {
    process.env["NO_PROXY"] = "corp.example.com";
    process.env["no_proxy"] = "corp.example.com";
  }

  function setGatewayOnlyProxyEnv() {
    process.env["HTTP_PROXY"] = "http://127.0.0.1:3128";
    process.env["HTTPS_PROXY"] = "http://127.0.0.1:3128";
  }

  function registerGatewayOnlyProxy() {
    return registerActiveManagedProxyUrl(new URL("http://127.0.0.1:3128"), "gateway-only");
  }

  test("uses a large maxPayload for node snapshots", () => {
    const last = startGatewayClient({ url: "ws://127.0.0.1:1" }) as {
      url: unknown;
      opts: unknown;
    } | null;
    const opts = last?.opts as { maxPayload?: number } | undefined;

    expect(last?.url).toBe("ws://127.0.0.1:1");
    expect(opts?.maxPayload).toBe(25 * 1024 * 1024);
  });

  test("does not pass an explicit direct agent for loopback control-plane WebSocket connections", () => {
    expectNoGatewayClientAgent({ url: "ws://127.0.0.1:1" });
  });

  test("does not pass an explicit direct agent for IPv6 loopback control-plane WebSocket connections", () => {
    expectNoGatewayClientAgent({ url: "ws://[::1]:1" });
  });

  test("does not pass an explicit direct agent for localhost hostnames", () => {
    expectNoGatewayClientAgent({ url: "ws://localhost:1" });
  });

  test("does not force a direct agent for remote Gateway WebSocket connections", () => {
    expectNoGatewayClientAgent({
      url: "wss://gateway.example.com",
      tlsFingerprint: "SHA256:AA:BB",
    });
  });

  test("scopes Gateway loopback bypass to WebSocket connection setup without mutating NO_PROXY", () => {
    setCorporateNoProxy();
    const registration = registerGatewayOnlyProxy();

    try {
      const last = startGatewayClient({ url: "ws://127.0.0.1:18789" }) as {
        noProxyDuringConstruction: unknown;
      } | null;

      expect(last?.noProxyDuringConstruction).toBe("corp.example.com");
      expect(process.env["NO_PROXY"]).toBe("corp.example.com");
      expect(process.env["no_proxy"]).toBe("corp.example.com");
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  test("scopes IPv6 loopback bypass during Gateway-only proxy mode connection setup", () => {
    setCorporateNoProxy();
    setGatewayOnlyProxyEnv();
    const registration = registerGatewayOnlyProxy();

    try {
      const last = startGatewayClient({ url: "ws://[::1]:18789" }) as {
        noProxyDuringConstruction: unknown;
        httpProxyDuringConstruction: unknown;
        httpsProxyDuringConstruction: unknown;
      } | null;

      expect(last?.noProxyDuringConstruction).toBe("corp.example.com");
      expect(last?.httpProxyDuringConstruction).toBe("http://127.0.0.1:3128");
      expect(last?.httpsProxyDuringConstruction).toBe("http://127.0.0.1:3128");
      expect(process.env["NO_PROXY"]).toBe("corp.example.com");
      expect(process.env["no_proxy"]).toBe("corp.example.com");
      expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
      expect(process.env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    } finally {
      stopActiveManagedProxyRegistration(registration);
    }
  });

  it("returns 404 for missing static asset paths instead of SPA fallback", async () => {
    await withControlUiRoot({ faviconSvg: "<svg/>" }, async (tmp) => {
      await expectControlUiStatus(tmp, { url: "/webchat/favicon.svg", statusCode: 404 });
    });
  });

  it("returns 404 for missing static assets with query strings", async () => {
    await withControlUiRoot({}, async (tmp) => {
      await expectControlUiStatus(tmp, { url: "/webchat/favicon.svg?v=1", statusCode: 404 });
    });
  });

  it("still serves SPA fallback for extensionless paths", async () => {
    await withControlUiRoot({}, async (tmp) => {
      await expectControlUiStatus(tmp, { url: "/webchat/chat", statusCode: 200 });
    });
  });

  it("HEAD returns 404 for missing static assets consistent with GET", async () => {
    await withControlUiRoot({}, async (tmp) => {
      await expectControlUiStatus(tmp, {
        url: "/webchat/favicon.svg",
        method: "HEAD",
        statusCode: 404,
      });
    });
  });

  it("serves SPA fallback for dotted path segments that are not static assets", async () => {
    await withControlUiRoot({}, async (tmp) => {
      for (const route of ["/webchat/user/jane.doe", "/webchat/v2.0", "/settings/v1.2"]) {
        await expectControlUiStatus(tmp, { url: route, statusCode: 200 });
      }
    });
  });

  it("serves SPA fallback for .html paths that do not exist on disk", async () => {
    await withControlUiRoot({}, async (tmp) => {
      await expectControlUiStatus(tmp, { url: "/webchat/foo.html", statusCode: 200 });
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

function makeOperatorWsClient(connId: string, socket: TestSocket, scopes: string[]) {
  return makeGatewayWsClient(connId, socket, {
    role: "operator",
    scopes,
  } as GatewayWsClient["connect"]);
}

function makeOperatorWsClients(
  entries: Array<{ connId: string; socket: TestSocket; scopes: string[] }>,
) {
  return new Set<GatewayWsClient>(
    entries.map(({ connId, socket, scopes }) => makeOperatorWsClient(connId, socket, scopes)),
  );
}

function makeReadPairClients(
  first: { connId: string; socket: TestSocket; scopes: string[] },
  readSocket: TestSocket,
) {
  return makeOperatorWsClients([
    first,
    { connId: "c-read", socket: readSocket, scopes: ["operator.read"] },
  ]);
}

function makeScopedBroadcastClients() {
  const pairingSocket = makeRecordingSocket();
  const nodeSocket = makeRecordingSocket();
  const readSocket = makeRecordingSocket();
  const writeSocket = makeRecordingSocket();
  const adminSocket = makeRecordingSocket();
  const clients = new Set<GatewayWsClient>([
    makeOperatorWsClient("c-pairing", pairingSocket, ["operator.pairing"]),
    makeGatewayWsClient("c-node", nodeSocket, {
      role: "node",
      scopes: ["operator.read"],
    } as GatewayWsClient["connect"]),
    makeOperatorWsClient("c-read", readSocket, ["operator.read"]),
    makeOperatorWsClient("c-write", writeSocket, ["operator.write"]),
    makeOperatorWsClient("c-admin", adminSocket, ["operator.admin"]),
  ]);

  return { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, clients };
}

function makeScopedBroadcastContext() {
  const scoped = makeScopedBroadcastClients();
  return {
    ...scoped,
    ...createGatewayBroadcaster({ clients: scoped.clients }),
  };
}

function sentEvents(socket: RecordingSocket) {
  return socket.sent.map((frame) => frame.event);
}

function expectSentEvents(socket: RecordingSocket, events: string[]) {
  expect(sentEvents(socket)).toEqual(events);
}

function sentEventSeq(socket: RecordingSocket) {
  return socket.sent.map((frame) => [frame.event, frame.seq]);
}

function chatPayload() {
  return { sessionKey: "agent:main:main", message: "secret" };
}

function chatSideResultPayload() {
  return { sessionKey: "agent:main:main", text: "tool output" };
}

function broadcastChatClassEvents(
  broadcast: ReturnType<typeof createGatewayBroadcaster>["broadcast"],
) {
  broadcast("chat", chatPayload());
  broadcast("agent", { type: "status", sessionKey: "agent:main:main" });
  broadcast("chat.send_timing", { phase: "dispatch-started", runId: "run-1" });
  broadcast("chat.side_result", chatSideResultPayload());
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
      makeOperatorWsClient("c-approvals", approvalsSocket, ["operator.approvals"]),
      makeOperatorWsClient("c-pairing", pairingSocket, ["operator.pairing"]),
      makeOperatorWsClient("c-read", readSocket, ["operator.read"]),
    ]);

    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

    broadcast("exec.approval.requested", { id: "1" });
    broadcast("device.pair.requested", { requestId: "r1" });

    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
    expect(readSocket.send).toHaveBeenCalledTimes(0);

    broadcastToConnIds("tick", { ts: 1 }, new Set(["c-read"]));
    broadcastToConnIds("talk.event", { type: "session.ready" }, new Set(["c-read"]));
    expect(readSocket.send).toHaveBeenCalledTimes(2);
    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
  });

  it("requires operator.read for chat-class broadcast events", () => {
    const { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, broadcast } =
      makeScopedBroadcastContext();

    broadcastChatClassEvents(broadcast);

    expect(pairingSocket.send).not.toHaveBeenCalled();
    expect(nodeSocket.send).not.toHaveBeenCalled();
    expect(readSocket.send).toHaveBeenCalledTimes(4);
    expect(writeSocket.send).toHaveBeenCalledTimes(4);
    expect(adminSocket.send).toHaveBeenCalledTimes(4);
    const expectedEvents = ["chat", "agent", "chat.send_timing", "chat.side_result"];
    expectSentEvents(readSocket, expectedEvents);
    expectSentEvents(writeSocket, expectedEvents);
    expectSentEvents(adminSocket, expectedEvents);
  });

  it("requires operator.read for task ledger broadcast events", () => {
    const { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, broadcast } =
      makeScopedBroadcastContext();

    broadcast("task", { action: "deleted", taskId: "task-1" });

    expect(pairingSocket.send).not.toHaveBeenCalled();
    expect(nodeSocket.send).not.toHaveBeenCalled();
    expectSentEvents(readSocket, ["task"]);
    expectSentEvents(writeSocket, ["task"]);
    expectSentEvents(adminSocket, ["task"]);
  });

  it("allows plugin.* broadcast events for operator.write and operator.admin", () => {
    const { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, broadcast } =
      makeScopedBroadcastContext();

    broadcast("plugin.myplugin.custom", { data: "test" });
    broadcast("plugin.otherplugin.state", { state: "updated" });

    expect(pairingSocket.send).not.toHaveBeenCalled();
    expect(nodeSocket.send).not.toHaveBeenCalled();
    expect(readSocket.send).not.toHaveBeenCalled();
    expect(writeSocket.send).toHaveBeenCalledTimes(2);
    expect(adminSocket.send).toHaveBeenCalledTimes(2);
    const expectedEvents = ["plugin.myplugin.custom", "plugin.otherplugin.state"];
    expectSentEvents(writeSocket, expectedEvents);
    expectSentEvents(adminSocket, expectedEvents);
  });

  it("defaults unknown events to deny and classifies remaining gateway broadcast events", () => {
    const { pairingSocket, nodeSocket, readSocket, writeSocket, adminSocket, broadcast } =
      makeScopedBroadcastContext();

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

    expectSentEvents(pairingSocket, [
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ]);
    expectSentEvents(nodeSocket, [
      "voicewake.changed",
      "voicewake.routing.changed",
      "heartbeat",
      "presence",
      "health",
      "tick",
      "shutdown",
      "update.available",
    ]);
    expectSentEvents(readSocket, [
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
    const writeVisibleEvents = [
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
    ];
    expectSentEvents(writeSocket, writeVisibleEvents);
    expectSentEvents(adminSocket, writeVisibleEvents);
  });

  it("keeps event seq contiguous per receiving client when scoped events are filtered", () => {
    const pairingSocket = makeRecordingSocket();
    const readSocket = makeRecordingSocket();

    const clients = makeReadPairClients(
      { connId: "c-pairing", socket: pairingSocket, scopes: ["operator.pairing"] },
      readSocket,
    );

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", chatPayload());
    broadcast("heartbeat", { ts: 1 });
    broadcast("chat.side_result", chatSideResultPayload());
    broadcast("tick", { ts: 2 });

    expect(sentEventSeq(pairingSocket)).toEqual([
      ["heartbeat", 1],
      ["tick", 2],
    ]);
    expect(sentEventSeq(readSocket)).toEqual([
      ["chat", 1],
      ["heartbeat", 2],
      ["chat.side_result", 3],
      ["tick", 4],
    ]);
  });

  it("reuses the same payload shape while assigning per-client seq values", () => {
    const firstSocket = makeRecordingSocket();
    const secondSocket = makeRecordingSocket();
    const thirdSocket = makeRecordingSocket();
    const clients = makeOperatorWsClients([
      { connId: "c-1", socket: firstSocket, scopes: ["operator.read"] },
      { connId: "c-2", socket: secondSocket, scopes: ["operator.write"] },
      { connId: "c-3", socket: thirdSocket, scopes: ["operator.admin"] },
    ]);
    const payloadKeys: string[] = [];
    const payload = {
      toJSON(key: string) {
        payloadKeys.push(key);
        return { foo: key };
      },
    };

    const { broadcast } = createGatewayBroadcaster({ clients });
    broadcast("talk.mode", { enabled: true });
    broadcast("chat", payload);

    expect(payloadKeys).toEqual(["payload"]);
    expect(firstSocket.sent.at(-1)?.payload).toEqual({ foo: "payload" });
    expect(secondSocket.sent.at(-1)?.payload).toEqual({ foo: "payload" });
    expect(thirdSocket.sent.at(-1)?.payload).toEqual({ foo: "payload" });
    expect([
      firstSocket.sent.at(-1)?.seq,
      secondSocket.sent.at(-1)?.seq,
      thirdSocket.sent.at(-1)?.seq,
    ]).toEqual([1, 2, 2]);
  });

  it("preserves seq gaps when dropIfSlow skips an eligible broadcast", () => {
    const slowReadSocket = makeRecordingSocket();
    slowReadSocket.bufferedAmount = Number.MAX_SAFE_INTEGER;
    const readSocket = makeRecordingSocket();

    const clients = makeReadPairClients(
      { connId: "c-slow-read", socket: slowReadSocket, scopes: ["operator.read"] },
      readSocket,
    );

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", chatPayload(), { dropIfSlow: true });
    slowReadSocket.bufferedAmount = 0;
    broadcast("heartbeat", { ts: 1 });

    expect(sentEventSeq(slowReadSocket)).toEqual([["heartbeat", 2]]);
    expect(sentEventSeq(readSocket)).toEqual([
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
        makeOperatorWsClient("c-slow-read", slowReadSocket, ["operator.read"]),
      ]);

      const { broadcast } = createGatewayBroadcaster({ clients });

      broadcast("chat", chatPayload(), { dropIfSlow: true });
      broadcast("heartbeat", { ts: 1 });

      const payloadEvent = events.find((event) => event.type === "payload.large");
      expect(payloadEvent?.type).toBe("payload.large");
      expect(payloadEvent?.surface).toBe("gateway.ws.outbound_buffer");
      expect(payloadEvent?.action).toBe("rejected");
      expect(payloadEvent?.bytes).toBe(MAX_BUFFERED_BYTES + 1);
      expect(payloadEvent?.limitBytes).toBe(MAX_BUFFERED_BYTES);
      expect(payloadEvent?.reason).toBe("ws_send_buffer_drop");
      expect(
        events.reduce((count, event) => count + (event.type === "payload.large" ? 1 : 0), 0),
      ).toBe(1);
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
      payloadJSON?: SerializedEventPayload | null;
    }> = [];
    const sendEvent = (evt: {
      nodeId: string;
      event: string;
      payloadJSON?: SerializedEventPayload | null;
    }) => sent.push(evt);

    manager.subscribe("node-a", "main");
    manager.subscribe("node-b", "main");
    manager.sendToSession("main", "chat", { ok: true }, sendEvent);

    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.nodeId).toSorted()).toEqual(["node-a", "node-b"]);
    expect(sent[0].event).toBe("chat");
  });

  test("runtime forwards subscribed node payload json without parsing it again", () => {
    const frames: string[] = [];
    const socket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn((payload: string) => frames.push(payload)),
      close: vi.fn(),
    };
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const runtime = createGatewayNodeSessionRuntime({ broadcast: vi.fn() });
      runtime.nodeRegistry.register(
        makeGatewayWsClient("conn-node-a", socket, {
          role: "node",
          scopes: [],
          client: {
            id: "node-client",
            version: "1.0.0",
            platform: "macos",
            mode: "node",
          },
          device: { id: "node-a" },
        } as unknown as GatewayWsClient["connect"]),
        {},
      );
      runtime.nodeSubscribe("node-a", "main");

      runtime.nodeSendToSession("main", "chat", { ok: true });

      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
    expect(JSON.parse(frames[0] ?? "{}")).toEqual({
      type: "event",
      event: "chat",
      payload: { ok: true },
    });
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

    expect(sent).toStrictEqual([]);
  });
});

describe("resolveNodeCommandAllowlist", () => {
  function expectAllowed(allow: { has: (cmd: string) => boolean }, commands: string[]) {
    for (const cmd of commands) {
      expect(allow.has(cmd)).toBe(true);
    }
  }

  function expectDenied(allow: { has: (cmd: string) => boolean }, commands: string[]) {
    for (const cmd of commands) {
      expect(allow.has(cmd)).toBe(false);
    }
  }

  function expectDangerousCommandsDenied(allow: { has: (cmd: string) => boolean }) {
    expectDenied(allow, DEFAULT_DANGEROUS_NODE_COMMANDS);
  }

  it("includes iOS service commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "iOS 26.0",
        deviceFamily: "iPhone",
      },
    );

    expectAllowed(allow, [
      "device.info",
      "device.status",
      "system.notify",
      "contacts.search",
      "calendar.events",
      "reminders.list",
      "photos.latest",
      "motion.activity",
    ]);
    expectDangerousCommandsDenied(allow);
  });

  it("includes Android notifications and device diagnostics commands by default", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "Android 16",
        deviceFamily: "Android",
      },
    );

    expectAllowed(allow, [
      "notifications.list",
      "notifications.actions",
      "device.permissions",
      "device.health",
      "device.apps",
      "callLog.search",
      "system.notify",
    ]);
    expectDenied(allow, ["sms.search"]);
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
        approvedCommands: ["screen.snapshot"],
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
        platform: "windows",
        deviceFamily: "Windows",
        approvedCommands: ["screen.snapshot", "system.run", "system.which"],
      },
    );

    expectDenied(allow, ["canvas.present", "canvas.a2ui.pushJSONL"]);
    expectAllowed(allow, [
      "camera.list",
      "location.get",
      "device.info",
      "device.status",
      "screen.snapshot",
      "system.run",
      "system.which",
      "system.notify",
    ]);
    expectDangerousCommandsDenied(allow);
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

    expectDenied(allow, ["system.run", "system.which"]);
    expectAllowed(allow, ["system.notify"]);
  });

  it("normalizes dotted-I platform values to iOS classification", () => {
    const allow = resolveNodeCommandAllowlist(
      {},
      {
        platform: "İOS",
        deviceFamily: "iPhone",
      },
    );

    expectDenied(allow, ["system.run", "system.which"]);
    expectAllowed(allow, ["device.info"]);
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

  test("does not split surrogate pairs at the length limit", () => {
    const prefix = "x".repeat(63);
    expect(normalizeVoiceWakeTriggers([`${prefix}\u{1f600}`])).toEqual([prefix]);
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
