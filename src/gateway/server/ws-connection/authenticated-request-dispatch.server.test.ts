import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  startGatewayServer,
  trackConnectChallengeNonce,
} from "../../test-helpers.js";
import {
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "../../test-helpers.plugin-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const TRACEPARENTS = {
  first: "00-11111111111111111111111111111111-1111111111111111-01",
  second: "00-22222222222222222222222222222222-2222222222222222-00",
} as const;

installGatewayTestHooks({ scope: "suite" });

function createClient(): GatewayWsClient {
  return {
    socket: {} as WebSocket,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "gateway-client",
        version: "dev",
        platform: "test",
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
    },
    connId: "conn-trace-test",
    usesSharedGatewayAuth: false,
  };
}

function createDispatcher(
  handler: NonNullable<GatewayWsMessageHandlerParams["extraHandlers"][string]>,
) {
  const send = vi.fn();
  const logGateway = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const dispatcher = createGatewayAuthenticatedRequestDispatcher({
    handler: {
      connId: "conn-trace-test",
      extraHandlers: { "test.trace": handler },
      buildRequestContext: () => ({}) as never,
      send,
      close: vi.fn(),
      isClosed: () => false,
      setCloseCause: vi.fn(),
      logGateway,
    } as unknown as GatewayWsMessageHandlerParams,
    isWebchatConnect: () => false,
  });
  return { dispatcher, logGateway, send };
}

async function dispatchInFreshMessageScope(
  dispatcher: ReturnType<typeof createDispatcher>["dispatcher"],
  client: GatewayWsClient,
  id: string,
  traceparent?: string,
): Promise<void> {
  await runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
    dispatcher.dispatch(
      {
        type: "req",
        id,
        method: "test.trace",
        params: {},
        ...(traceparent ? { traceparent } : {}),
      },
      client,
    ),
  );
}

async function openAuthenticatedTraceSocket(params: {
  port: number;
  token: string;
  connectTraceparent: string;
}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${params.port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      ws.off("open", onOpen);
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
  try {
    await connectOk(ws, {
      token: params.token,
      traceparent: params.connectTraceparent,
    });
    return ws;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

async function sendTraceRequest(
  ws: WebSocket,
  id: string,
  traceparent?: string,
): Promise<{ ok: boolean }> {
  const response = onceMessage<{ type: "res"; id: string; ok: boolean }>(
    ws,
    (value) => value.type === "res" && value.id === id,
  );
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "test.trace",
      params: {},
      ...(traceparent ? { traceparent } : {}),
    }),
  );
  return await response;
}

describe("authenticated WebSocket request trace dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("continues a valid upstream trace as a child context", async () => {
    let observed: DiagnosticTraceContext | undefined;
    const { dispatcher } = createDispatcher(() => {
      observed = getActiveDiagnosticTraceContext();
    });

    await dispatchInFreshMessageScope(dispatcher, createClient(), "first", TRACEPARENTS.first);
    await vi.waitFor(() => {
      expect(observed).toBeDefined();
    });

    expect(observed).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    });
    expect(observed?.spanId).not.toBe("1111111111111111");
  });

  it("keeps handler failure logging and responses inside the request trace", async () => {
    let loggedContext: DiagnosticTraceContext | undefined;
    let responseContext: DiagnosticTraceContext | undefined;
    const { dispatcher, logGateway, send } = createDispatcher(async () => {
      throw new Error("expected trace failure");
    });
    logGateway.error.mockImplementation(() => {
      loggedContext = getActiveDiagnosticTraceContext();
    });
    send.mockImplementation(() => {
      responseContext = getActiveDiagnosticTraceContext();
    });

    await dispatchInFreshMessageScope(dispatcher, createClient(), "failure", TRACEPARENTS.first);
    await vi.waitFor(() => {
      expect(logGateway.error).toHaveBeenCalled();
      expect(send).toHaveBeenCalled();
    });

    expect(loggedContext).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    });
    expect(responseContext).toEqual(loggedContext);
  });

  it("retains fresh roots for missing and malformed traceparent values", async () => {
    const observed = new Map<string, DiagnosticTraceContext | undefined>();
    const { dispatcher } = createDispatcher(({ req }) => {
      observed.set(req.id, getActiveDiagnosticTraceContext());
    });
    const client = createClient();

    await dispatchInFreshMessageScope(dispatcher, client, "missing");
    await vi.waitFor(() => {
      expect(observed.has("missing")).toBe(true);
    });
    await dispatchInFreshMessageScope(
      dispatcher,
      client,
      "malformed",
      "00-11111111111111111111111111111111-1111111111111111-zz",
    );
    await vi.waitFor(() => {
      expect(observed.has("malformed")).toBe(true);
    });

    const missing = observed.get("missing");
    const malformed = observed.get("malformed");
    expect(missing).toBeDefined();
    expect(malformed).toBeDefined();
    expect(missing?.traceId).not.toBe("11111111111111111111111111111111");
    expect(malformed?.traceId).not.toBe("11111111111111111111111111111111");
    expect(missing?.traceId).not.toBe(malformed?.traceId);
  });

  it("isolates concurrent request contexts on one connection", async () => {
    let releaseRequests: (() => void) | undefined;
    const requestBarrier = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const observed = new Map<
      string,
      { before: DiagnosticTraceContext | undefined; after?: DiagnosticTraceContext }
    >();
    const { dispatcher } = createDispatcher(async ({ req }) => {
      const observation: {
        before: DiagnosticTraceContext | undefined;
        after?: DiagnosticTraceContext;
      } = { before: getActiveDiagnosticTraceContext() };
      observed.set(req.id, observation);
      await requestBarrier;
      observation.after = getActiveDiagnosticTraceContext();
    });
    const client = createClient();

    await Promise.all([
      dispatchInFreshMessageScope(dispatcher, client, "first", TRACEPARENTS.first),
      dispatchInFreshMessageScope(dispatcher, client, "second", TRACEPARENTS.second),
    ]);
    await vi.waitFor(() => {
      expect(observed.size).toBe(2);
    });
    releaseRequests?.();
    await vi.waitFor(() => {
      expect([...observed.values()].every((entry) => entry.after)).toBe(true);
    });

    expect(observed.get("first")?.before?.traceId).toBe("11111111111111111111111111111111");
    expect(observed.get("second")?.before?.traceId).toBe("22222222222222222222222222222222");
    expect(observed.get("first")?.after).toEqual(observed.get("first")?.before);
    expect(observed.get("second")?.after).toEqual(observed.get("second")?.before);
  });

  it("preserves request isolation through a real authenticated WebSocket session", async () => {
    const observed = new Map<
      string,
      { before: DiagnosticTraceContext | undefined; after?: DiagnosticTraceContext }
    >();
    let requestBarrier: Promise<void> | undefined;
    let releaseRequests: (() => void) | undefined;
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.trace"] = async ({ req, respond }) => {
      const observation: {
        before: DiagnosticTraceContext | undefined;
        after?: DiagnosticTraceContext;
      } = { before: getActiveDiagnosticTraceContext() };
      observed.set(req.id, observation);
      await requestBarrier;
      observation.after = getActiveDiagnosticTraceContext();
      respond(true, { traced: true });
    };
    setTestPluginRegistry(registry);

    const token = "gateway-request-trace-test-token";
    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
    });
    let ws: WebSocket | undefined;
    try {
      ws = await openAuthenticatedTraceSocket({
        port,
        token,
        connectTraceparent: TRACEPARENTS.first,
      });

      await expect(sendTraceRequest(ws, "untraced-after-connect")).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        sendTraceRequest(
          ws,
          "malformed",
          "00-11111111111111111111111111111111-1111111111111111-zz",
        ),
      ).resolves.toMatchObject({ ok: true });
      const afterConnect = observed.get("untraced-after-connect")?.before;
      const malformed = observed.get("malformed")?.before;
      expect(afterConnect).toBeDefined();
      expect(malformed).toBeDefined();
      expect(afterConnect?.traceId).not.toBe("11111111111111111111111111111111");
      expect(malformed?.traceId).not.toBe("11111111111111111111111111111111");
      expect(malformed?.traceId).not.toBe(afterConnect?.traceId);

      requestBarrier = new Promise<void>((resolve) => {
        releaseRequests = resolve;
      });
      const first = sendTraceRequest(ws, "concurrent-first", TRACEPARENTS.first);
      const second = sendTraceRequest(ws, "concurrent-second", TRACEPARENTS.second);
      await vi.waitFor(() => {
        expect(observed.has("concurrent-first")).toBe(true);
        expect(observed.has("concurrent-second")).toBe(true);
      });
      releaseRequests?.();
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { ok: true },
        { ok: true },
      ]);

      const firstObservation = observed.get("concurrent-first");
      const secondObservation = observed.get("concurrent-second");
      expect(firstObservation?.before).toMatchObject({
        traceId: "11111111111111111111111111111111",
        parentSpanId: "1111111111111111",
        traceFlags: "01",
      });
      expect(secondObservation?.before).toMatchObject({
        traceId: "22222222222222222222222222222222",
        parentSpanId: "2222222222222222",
        traceFlags: "00",
      });
      expect(firstObservation?.after).toEqual(firstObservation?.before);
      expect(secondObservation?.after).toEqual(secondObservation?.before);
    } finally {
      ws?.terminate();
      await server.close();
      resetTestPluginRegistry();
    }
  });
});
