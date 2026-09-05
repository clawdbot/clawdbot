import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { createOperationalRunInstanceRef } from "../../../agents/admitted-run-context.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore, type Deferred } from "../../../shared/deferred.js";
import type { AgentRuntimeIdentity } from "../../agent-runtime-identity-token.js";
import {
  connectOk,
  getGatewayTestPort,
  installGatewayTestHooks,
  onceMessage,
  startTestGatewayServer,
  trackConnectChallengeNonce,
} from "../../test-helpers.js";
import {
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "../../test-helpers.plugin-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const TRACEPARENTS = {
  first: "00-11111111111111111111111111111111-1111111111111111-01",
  second: "00-22222222222222222222222222222222-2222222222222222-00",
} as const;

installGatewayTestHooks({ scope: "suite" });

function createClient(): GatewayWsClient {
  return createOperatorWsClient({ connId: "conn-trace-test" });
}

function createTestAgentRuntimeIdentity(runId: string): AgentRuntimeIdentity {
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:test",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: `generation-${runId}`,
      claimId: `claim-${runId}`,
    },
  };
}

function createDispatcher(
  handler: NonNullable<GatewayWsMessageHandlerParams["extraHandlers"][string]>,
  context: Record<string, unknown> = {},
) {
  return createDispatchTestHarness({
    connId: "conn-trace-test",
    extraHandlers: { "test.trace": handler },
    buildRequestContext: () => context,
  });
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

async function warmDispatcher(
  harness: ReturnType<typeof createDispatchTestHarness>,
  client: GatewayWsClient,
): Promise<void> {
  await harness.dispatcher.dispatch(
    { type: "req", id: "warmup", method: "test.trace", params: {} },
    client,
  );
  await harness.awaitResponseFrame("warmup");
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
    const handled = createDeferredCore();
    const { dispatcher } = createDispatcher(() => {
      observed = getActiveDiagnosticTraceContext();
      handled.resolve();
    });

    await dispatchInFreshMessageScope(dispatcher, createClient(), "first", TRACEPARENTS.first);
    await handled.promise;

    expect(observed).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    });
    expect(observed?.spanId).not.toBe("1111111111111111");
  });

  it("rejects a cached agent runtime identity after its delegated authority closes", async () => {
    const handler = vi.fn();
    const validateAgentRuntimeApprovalAuthority = vi.fn(() => false);
    const { close, dispatcher, send, setCloseCause } = createDispatcher(handler, {
      validateAgentRuntimeApprovalAuthority,
    });
    const client = createClient();
    const agentRuntimeIdentity = createTestAgentRuntimeIdentity("closed-authority");
    client.internal = { agentRuntimeIdentity };

    await dispatchInFreshMessageScope(dispatcher, client, "closed-authority");

    expect(validateAgentRuntimeApprovalAuthority).toHaveBeenCalledWith(agentRuntimeIdentity);
    expect(handler).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "closed-authority",
        ok: false,
        error: expect.objectContaining({ message: "agent runtime authority is no longer active" }),
      }),
    );
    expect(setCloseCause).toHaveBeenCalledWith("agent-runtime-authority-closed", {
      method: "test.trace",
    });
    expect(close).toHaveBeenCalledWith(4001, "agent runtime authority closed");
  });

  it("revalidates delegated authority before returning a post-await result", async () => {
    let authorityActive = true;
    const invoked = createDeferredCore();
    const held = createDeferredCore();
    const handler = vi.fn(async ({ respond }) => {
      invoked.resolve();
      await held.promise;
      respond(true, { exposed: true }, undefined);
    });
    const validateAgentRuntimeApprovalAuthority = vi.fn(() => authorityActive);
    const { awaitResponseFrame, close, dispatcher, send } = createDispatcher(handler, {
      validateAgentRuntimeApprovalAuthority,
    });
    const client = createClient();
    client.internal = {
      agentRuntimeIdentity: createTestAgentRuntimeIdentity("closed-before-result"),
    };

    const dispatch = dispatchInFreshMessageScope(dispatcher, client, "closed-before-result");
    try {
      await invoked.promise;
      expect(handler).toHaveBeenCalledOnce();
      authorityActive = false;
    } finally {
      held.resolve();
      await dispatch;
    }

    expect(await awaitResponseFrame("closed-before-result")).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: "agent runtime authority is no longer active",
      }),
    });
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "closed-before-result", ok: true }),
    );
    expect(close).toHaveBeenCalledWith(4001, "agent runtime authority closed");
  });

  it.each([
    { change: "shared-auth", closeReason: "gateway auth changed" },
    { change: "invalidated", closeReason: "client invalidated: device-token-revoked" },
    { change: "runtime", closeReason: "agent runtime authority closed" },
  ] as const)("revalidates $change authority after waiting to start", async (testCase) => {
    let generation = "current";
    let runtimeActive = true;
    let pendingStarted = false;
    const client = createClient();
    if (testCase.change === "shared-auth") {
      client.usesSharedGatewayAuth = true;
      client.sharedGatewaySessionGeneration = generation;
    }
    if (testCase.change === "runtime") {
      client.internal = { agentRuntimeIdentity: createTestAgentRuntimeIdentity("pending-start") };
    }
    const harness = createDispatchTestHarness({
      getRequiredSharedGatewaySessionGeneration: () => generation,
      buildRequestContext: () => ({ validateAgentRuntimeApprovalAuthority: () => runtimeActive }),
      extraHandlers: {
        "test.trace": ({ req, respond }) => {
          pendingStarted ||= req.id === "pending";
          respond(true, { completed: req.id });
        },
      },
    });
    await warmDispatcher(harness, client);
    const dispatch = harness.dispatcher.dispatch(
      { type: "req", id: "pending", method: "test.trace", params: {} },
      client,
    );
    expect(pendingStarted).toBe(false);
    if (testCase.change === "shared-auth") {
      generation = "rotated";
    } else if (testCase.change === "invalidated") {
      client.invalidated = true;
      client.invalidatedReason = "device-token-revoked";
    } else {
      runtimeActive = false;
    }
    await dispatch;
    expect(pendingStarted).toBe(false);
    expect(harness.close).toHaveBeenCalledWith(4001, testCase.closeReason);
    expect(harness.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "pending", ok: true }),
    );
  });

  it.each([
    {
      label: "ordinary UI node invocation",
      method: "node.invoke",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.UI,
      cancel: false,
    },
    {
      label: "CLI node invocation",
      method: "node.invoke",
      id: GATEWAY_CLIENT_IDS.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      cancel: true,
    },
    {
      label: "session companion ask",
      method: "sessions.companion.ask",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.UI,
      cancel: true,
    },
  ])("preserves pending $label disconnect policy", async (testCase) => {
    const socket = new EventEmitter();
    let disconnected = false;
    let pendingStarted = false;
    let pendingSignal: AbortSignal | undefined;
    const handler: NonNullable<GatewayWsMessageHandlerParams["extraHandlers"][string]> = ({
      req,
      respond,
      signal,
    }) => {
      if (req.id === "pending") {
        pendingStarted = true;
        pendingSignal = signal;
      }
      respond(true, { completed: req.id });
    };
    const client = createOperatorWsClient({ socket, clientInfo: testCase });
    const harness = createDispatchTestHarness({
      isClosed: () => disconnected,
      extraHandlers: { "test.trace": handler, [testCase.method]: handler },
    });
    await warmDispatcher(harness, client);
    const dispatch = harness.dispatcher.dispatch(
      { type: "req", id: "pending", method: testCase.method, params: {} },
      client,
    );
    expect(pendingStarted).toBe(false);
    disconnected = true;
    socket.emit("close", 1000, Buffer.alloc(0));

    await dispatch;
    expect(pendingStarted).toBe(!testCase.cancel);
    if (!testCase.cancel) {
      expect(await harness.awaitResponseFrame("pending")).toMatchObject({ ok: true });
      expect(pendingSignal).toBeUndefined();
    } else {
      expect(harness.send).not.toHaveBeenCalledWith(expect.objectContaining({ id: "pending" }));
    }
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("keeps handler failure logging and responses inside the request trace", async () => {
    let loggedContext: DiagnosticTraceContext | undefined;
    let responseContext: DiagnosticTraceContext | undefined;
    const { awaitResponseFrame, dispatcher, logGateway, send } = createDispatcher(async () => {
      throw new Error("expected trace failure");
    });
    logGateway.error.mockImplementation(() => {
      loggedContext = getActiveDiagnosticTraceContext();
    });
    send.mockImplementation(() => {
      responseContext = getActiveDiagnosticTraceContext();
      return { kind: "sent" } as const;
    });

    await dispatchInFreshMessageScope(dispatcher, createClient(), "failure", TRACEPARENTS.first);
    await awaitResponseFrame("failure");
    expect(logGateway.error).toHaveBeenCalled();

    expect(loggedContext).toMatchObject({
      traceId: "11111111111111111111111111111111",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    });
    expect(responseContext).toEqual(loggedContext);
  });

  it("retains fresh roots for missing and malformed traceparent values", async () => {
    const observed = new Map<string, DiagnosticTraceContext | undefined>();
    let handled = createDeferredCore();
    const { dispatcher } = createDispatcher(({ req }) => {
      observed.set(req.id, getActiveDiagnosticTraceContext());
      handled.resolve();
    });
    const client = createClient();

    await dispatchInFreshMessageScope(dispatcher, client, "missing");
    await handled.promise;
    handled = createDeferredCore();
    await dispatchInFreshMessageScope(
      dispatcher,
      client,
      "malformed",
      "00-11111111111111111111111111111111-1111111111111111-zz",
    );
    await handled.promise;

    const missing = observed.get("missing");
    const malformed = observed.get("malformed");
    expect(missing).toBeDefined();
    expect(malformed).toBeDefined();
    expect(missing?.traceId).not.toBe("11111111111111111111111111111111");
    expect(malformed?.traceId).not.toBe("11111111111111111111111111111111");
    expect(missing?.traceId).not.toBe(malformed?.traceId);
  });

  it("isolates concurrent request contexts on one connection", async () => {
    const requestBarrier = createDeferredCore();
    const bothObserved = createDeferredCore();
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
      if (observed.size === 2) {
        bothObserved.resolve();
      }
      await requestBarrier.promise;
      observation.after = getActiveDiagnosticTraceContext();
    });
    const client = createClient();

    const parent = tryBeginGatewayRootWorkAdmission();
    if (!parent) {
      throw new Error("expected open parent work admission");
    }
    const dispatches = parent.run(() =>
      Promise.all([
        dispatchInFreshMessageScope(dispatcher, client, "first", TRACEPARENTS.first),
        dispatchInFreshMessageScope(dispatcher, client, "second", TRACEPARENTS.second),
      ]),
    );
    try {
      await bothObserved.promise;
      // The pending starts retain their traces but cannot borrow the parent root.
      expect(getActiveGatewayRootWorkCount()).toBe(3);
    } finally {
      requestBarrier.resolve();
      parent.release();
      await dispatches;
    }

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
    const bothConcurrentObserved = createDeferredCore();
    let requestBarrier: Deferred | undefined;
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.trace"] = async ({ req, respond }) => {
      const observation: {
        before: DiagnosticTraceContext | undefined;
        after?: DiagnosticTraceContext;
      } = { before: getActiveDiagnosticTraceContext() };
      observed.set(req.id, observation);
      if (observed.has("concurrent-first") && observed.has("concurrent-second")) {
        bothConcurrentObserved.resolve();
      }
      await requestBarrier?.promise;
      observation.after = getActiveDiagnosticTraceContext();
      respond(true, { traced: true });
    };
    setTestPluginRegistry(registry);

    const token = "gateway-request-trace-test-token";
    const port = await getGatewayTestPort();
    const server = await startTestGatewayServer(port, {
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

      requestBarrier = createDeferredCore();
      const first = sendTraceRequest(ws, "concurrent-first", TRACEPARENTS.first);
      const second = sendTraceRequest(ws, "concurrent-second", TRACEPARENTS.second);
      await bothConcurrentObserved.promise;
      requestBarrier.resolve();
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

  it("returns a typed error when a handler response cannot be serialized", async () => {
    let invalidSerializationAttempts = 0;
    const healthySerializationAttempts = new Map<string, number>();
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.serialize"] = ({ req, respond }) => {
      const invalid = req.id === "invalid-payload";
      respond(true, {
        toJSON: () => {
          if (invalid) {
            invalidSerializationAttempts += 1;
            return { value: 1n };
          }
          const attempts = (healthySerializationAttempts.get(req.id) ?? 0) + 1;
          healthySerializationAttempts.set(req.id, attempts);
          if (attempts > 1) {
            throw new Error("healthy response serialized more than once");
          }
          return { value: 1 };
        },
      });
    };
    setTestPluginRegistry(registry);

    const token = "gateway-response-serialization-test-token";
    const port = await getGatewayTestPort();
    const server = await startTestGatewayServer(port, {
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
      const response = onceMessage<{ type: "res"; id: string; ok: boolean; error?: unknown }>(
        ws,
        (value) => value.type === "res" && value.id === "invalid-payload",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "invalid-payload",
          method: "test.serialize",
          params: {},
        }),
      );

      await expect(response).resolves.toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "response serialization failed" },
      });
      expect(invalidSerializationAttempts).toBe(1);
      await expect(
        onceMessage(ws, (value) => value.type === "res" && value.id === "invalid-payload", 100),
      ).rejects.toThrow("timeout");

      const healthyResponse = onceMessage<{ type: "res"; id: string; ok: boolean }>(
        ws,
        (value) => value.type === "res" && value.id === "healthy-after-error",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "healthy-after-error",
          method: "test.serialize",
          params: {},
        }),
      );
      await expect(healthyResponse).resolves.toMatchObject({ ok: true });
      expect(healthySerializationAttempts.get("healthy-after-error")).toBe(1);

      ws.terminate();
      ws = await openAuthenticatedTraceSocket({
        port,
        token,
        connectTraceparent: TRACEPARENTS.second,
      });
      const reconnectResponse = onceMessage<{ type: "res"; id: string; ok: boolean }>(
        ws,
        (value) => value.type === "res" && value.id === "healthy-after-reconnect",
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "healthy-after-reconnect",
          method: "test.serialize",
          params: {},
        }),
      );
      await expect(reconnectResponse).resolves.toMatchObject({ ok: true });
      expect(healthySerializationAttempts.get("healthy-after-reconnect")).toBe(1);
    } finally {
      ws?.terminate();
      await server.close();
      resetTestPluginRegistry();
    }
  });
});
