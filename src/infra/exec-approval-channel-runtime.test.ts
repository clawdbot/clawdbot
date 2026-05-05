import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

const mockGatewayClientStarts = vi.hoisted(() => vi.fn());
const mockGatewayClientStops = vi.hoisted(() => vi.fn());
const mockGatewayClientRequests = vi.hoisted(() =>
  vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({
    ok: true,
  })),
);
const mockCreateOperatorApprovalsGatewayClient = vi.hoisted(() => vi.fn());
const mockStartGatewayClientWhenEventLoopReady = vi.hoisted(() => vi.fn());
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: mockCreateOperatorApprovalsGatewayClient,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mockStartGatewayClientWhenEventLoopReady,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

let createExecApprovalChannelRuntime: typeof import("./exec-approval-channel-runtime.js").createExecApprovalChannelRuntime;
let ExecApprovalChannelRuntimeTerminalStartError: typeof import("./exec-approval-channel-runtime.js").ExecApprovalChannelRuntimeTerminalStartError;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

type GatewayEventClientParams = { onEvent?: (evt: { event: string; payload: unknown }) => void };

function lastGatewayEventClientParams(): GatewayEventClientParams | undefined {
  return mockCreateOperatorApprovalsGatewayClient.mock.calls[0]?.[0] as
    | GatewayEventClientParams
    | undefined;
}

function emitPluginApprovalRequested(clientParams = lastGatewayEventClientParams()) {
  clientParams?.onEvent?.({
    event: "plugin.approval.requested",
    payload: createPluginReplayRequest("plugin:abc"),
  });
}

function createExecReplayRequest(id = "abc"): ExecApprovalRequest {
  return {
    id,
    request: {
      command: "echo abc",
    },
    createdAtMs: 1000,
    expiresAtMs: 2000,
  };
}

function createPluginReplayRequest(id = "plugin:abc"): PluginApprovalRequest {
  return {
    id,
    request: {
      title: "Plugin approval",
      description: "Let plugin proceed",
    },
    createdAtMs: 1000,
    expiresAtMs: 2000,
  };
}

function mockReplayLists(params: {
  exec?: ExecApprovalRequest[];
  plugin?: PluginApprovalRequest[];
}) {
  mockGatewayClientRequests.mockImplementation(async (method: string) => {
    if (method === "exec.approval.list") {
      return params.exec ?? [];
    }
    if (method === "plugin.approval.list") {
      return params.plugin ?? [];
    }
    return { ok: true };
  });
}

beforeEach(() => {
  mockGatewayClientStarts.mockReset();
  mockGatewayClientStops.mockReset();
  mockGatewayClientRequests.mockReset();
  mockGatewayClientRequests.mockImplementation(async (method: string) =>
    method.endsWith(".approval.list") ? [] : { ok: true },
  );
  mockStartGatewayClientWhenEventLoopReady.mockReset().mockImplementation(async (client) => {
    client.start();
    return { ready: true, elapsedMs: 0, maxDriftMs: 0, checks: 2, aborted: false };
  });
  loggerMocks.debug.mockReset();
  loggerMocks.error.mockReset();
  mockCreateOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (params) => ({
    start: () => {
      mockGatewayClientStarts();
      queueMicrotask(() => {
        params.onHelloOk?.({ type: "hello-ok" } as never);
      });
    },
    stop: mockGatewayClientStops,
    request: mockGatewayClientRequests,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeAll(async () => {
  ({ createExecApprovalChannelRuntime, ExecApprovalChannelRuntimeTerminalStartError } =
    await import("./exec-approval-channel-runtime.js"));
});

describe("createExecApprovalChannelRuntime", () => {
  it("does not connect when the adapter is not configured", async () => {
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => false,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    await runtime.start();

    expect(mockCreateOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it("tracks pending requests and only expires the matching approval id", async () => {
    vi.useFakeTimers();
    const finalizedExpired = vi.fn(async () => undefined);
    const finalizedResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      nowMs: () => 1000,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async (request) => [{ id: request.id }],
      finalizeResolved: finalizedResolved,
      finalizeExpired: finalizedExpired,
    });

    await runtime.handleRequested({
      id: "abc",
      request: {
        command: "echo abc",
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });
    await runtime.handleRequested({
      id: "xyz",
      request: {
        command: "echo xyz",
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });

    await runtime.handleExpired("abc");

    expect(finalizedExpired).toHaveBeenCalledTimes(1);
    expect(finalizedExpired).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "abc" }),
      entries: [{ id: "abc" }],
    });
    expect(finalizedResolved).not.toHaveBeenCalled();

    await runtime.handleResolved({
      id: "xyz",
      decision: "allow-once",
      ts: 1500,
    });

    expect(finalizedResolved).toHaveBeenCalledTimes(1);
    expect(finalizedResolved).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "xyz" }),
      resolved: expect.objectContaining({ id: "xyz", decision: "allow-once" }),
      entries: [{ id: "xyz" }],
    });
  });

  it("finalizes approvals that resolve while delivery is still in flight", async () => {
    const pendingDelivery = createDeferred<Array<{ id: string }>>();
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      label: "test/plugin-approvals",
      clientDisplayName: "Test Plugin Approvals",
      cfg: {} as never,
      eventKinds: ["plugin"],
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => pendingDelivery.promise,
      finalizeResolved,
    });

    const requestPromise = runtime.handleRequested({
      id: "plugin:abc",
      request: {
        title: "Plugin approval",
        description: "Let plugin proceed",
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });
    await runtime.handleResolved({
      id: "plugin:abc",
      decision: "allow-once",
      ts: 1500,
    });

    pendingDelivery.resolve([{ id: "plugin:abc" }]);
    await requestPromise;

    expect(finalizeResolved).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "plugin:abc" }),
      resolved: expect.objectContaining({ id: "plugin:abc", decision: "allow-once" }),
      entries: [{ id: "plugin:abc" }],
    });
  });

  it("routes gateway requests through the shared client", async () => {
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    await runtime.start();
    await runtime.request("exec.approval.resolve", { id: "abc", decision: "deny" });

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(mockStartGatewayClientWhenEventLoopReady).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Function) }),
      {
        clientOptions: { preauthHandshakeTimeoutMs: undefined },
      },
    );
    expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "abc",
      decision: "deny",
    });
  });

  it("fails startup when gateway client readiness times out before start", async () => {
    mockStartGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: false,
      elapsedMs: 30_000,
      maxDriftMs: 1_000,
      checks: 1,
      aborted: false,
    });
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: { gateway: { handshakeTimeoutMs: 30_000 } } as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    await expect(runtime.start()).rejects.toThrow(
      "gateway readiness unavailable before exec approval runtime start",
    );

    expect(mockGatewayClientStarts).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalledTimes(1);
    expect(mockStartGatewayClientWhenEventLoopReady).toHaveBeenCalledWith(
      expect.objectContaining({ start: expect.any(Function) }),
      {
        clientOptions: { preauthHandshakeTimeoutMs: 30_000 },
      },
    );
  });

  it("can retry start after gateway client creation fails", async () => {
    const boom = new Error("boom");
    mockCreateOperatorApprovalsGatewayClient
      .mockRejectedValueOnce(boom)
      .mockImplementationOnce(async (params) => ({
        start: () => {
          mockGatewayClientStarts();
          queueMicrotask(() => {
            params.onHelloOk?.({ type: "hello-ok" } as never);
          });
        },
        stop: mockGatewayClientStops,
        request: mockGatewayClientRequests,
      }));
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    await expect(runtime.start()).rejects.toThrow("boom");
    await runtime.start();

    expect(mockCreateOperatorApprovalsGatewayClient).toHaveBeenCalledTimes(2);
    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
  });

  it("waits through retryable connect auth errors until hello succeeds", async () => {
    const authError = Object.assign(new Error("gateway token mismatch"), {
      details: {
        code: "AUTH_TOKEN_MISMATCH",
        canRetryWithDeviceToken: true,
      },
    });
    mockCreateOperatorApprovalsGatewayClient.mockImplementationOnce(async (params) => ({
      start: () => {
        mockGatewayClientStarts();
        params.onConnectError?.(authError);
        queueMicrotask(() => {
          params.onHelloOk?.({ type: "hello-ok" } as never);
        });
      },
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    }));
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    await expect(runtime.start()).resolves.toBeUndefined();

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(loggerMocks.error).toHaveBeenCalledWith("connect error: gateway token mismatch");
  });

  it("surfaces reconnect pauses as terminal startup errors", async () => {
    const authError = Object.assign(new Error("pairing required"), {
      details: {
        code: "PAIRING_REQUIRED",
      },
    });
    mockCreateOperatorApprovalsGatewayClient.mockImplementationOnce(async (params) => ({
      start: () => {
        mockGatewayClientStarts();
        params.onConnectError?.(authError);
        params.onReconnectPaused?.({
          code: 1008,
          reason: "pairing required",
          detailCode: "PAIRING_REQUIRED",
        });
        params.onClose?.(1008, "pairing required");
      },
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    }));
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    let caught: unknown;
    await runtime.start().catch((error) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(ExecApprovalChannelRuntimeTerminalStartError);
    expect(caught).toMatchObject({
      detailCode: "PAIRING_REQUIRED",
    });

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(mockGatewayClientStops).toHaveBeenCalledTimes(1);
  });

  it("does not leave a gateway client running when stop wins the startup race", async () => {
    const pendingClient = createDeferred<GatewayClient>();
    mockCreateOperatorApprovalsGatewayClient.mockReturnValueOnce(pendingClient.promise);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/exec-approvals",
      clientDisplayName: "Test Exec Approvals",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => [],
      finalizeResolved: async () => undefined,
    });

    const startPromise = runtime.start();
    const stopPromise = runtime.stop();
    pendingClient.resolve({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests as GatewayClient["request"],
    } as unknown as GatewayClient);
    await startPromise;
    await stopPromise;

    expect(mockGatewayClientStarts).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalledTimes(1);
    await expect(runtime.request("exec.approval.resolve", { id: "abc" })).rejects.toThrow(
      "gateway client not connected",
    );
  });

  it("logs async request handling failures from gateway events", async () => {
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      label: "test/plugin-approvals",
      clientDisplayName: "Test Plugin Approvals",
      cfg: {} as never,
      eventKinds: ["plugin"],
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => {
        throw new Error("deliver failed");
      },
      finalizeResolved: async () => undefined,
    });

    await runtime.start();
    emitPluginApprovalRequested();

    await vi.waitFor(() => {
      expect(loggerMocks.error).toHaveBeenCalledWith(
        "error handling approval request: deliver failed",
      );
    });
  });

  it("logs async expiration handling failures", async () => {
    vi.useFakeTimers();
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      label: "test/plugin-approvals",
      clientDisplayName: "Test Plugin Approvals",
      cfg: {} as never,
      nowMs: () => 1000,
      eventKinds: ["plugin"],
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async (request) => [{ id: request.id }],
      finalizeResolved: async () => undefined,
      finalizeExpired: async () => {
        throw new Error("expire failed");
      },
    });

    await runtime.handleRequested({
      id: "plugin:abc",
      request: {
        title: "Plugin approval",
        description: "Let plugin proceed",
      },
      createdAtMs: 1000,
      expiresAtMs: 1001,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(loggerMocks.error).toHaveBeenCalledWith(
      "error handling approval expiration: expire failed",
    );
  });

  it("subscribes to plugin approval events when requested", async () => {
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      label: "test/plugin-approvals",
      clientDisplayName: "Test Plugin Approvals",
      cfg: {} as never,
      eventKinds: ["plugin"],
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved,
    });

    await runtime.start();
    const clientParams = lastGatewayEventClientParams();
    expect(clientParams?.onEvent).toBeTypeOf("function");

    emitPluginApprovalRequested(clientParams);
    await vi.waitFor(() => {
      expect(deliverRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "plugin:abc",
        }),
      );
    });

    clientParams?.onEvent?.({
      event: "plugin.approval.resolved",
      payload: {
        id: "plugin:abc",
        decision: "allow-once",
        ts: 1500,
      },
    });
    await vi.waitFor(() => {
      expect(finalizeResolved).toHaveBeenCalledWith({
        request: expect.objectContaining({ id: "plugin:abc" }),
        resolved: expect.objectContaining({ id: "plugin:abc", decision: "allow-once" }),
        entries: [{ id: "plugin:abc" }],
      });
    });
  });

  it("replays pending approvals after the gateway connection is ready", async () => {
    mockReplayLists({ exec: [createExecReplayRequest()] });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/replay",
      clientDisplayName: "Test Replay",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved: async () => undefined,
    });

    await runtime.start();

    await vi.waitFor(() => {
      expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.list", {});
      expect(deliverRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "abc",
        }),
      );
    });
  });

  it("does not block start on pending approval replay delivery", async () => {
    mockReplayLists({ exec: [createExecReplayRequest()] });
    const pendingDelivery = createDeferred<Array<{ id: string }>>();
    const deliverRequested = vi.fn(async () => pendingDelivery.promise);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/replay-start",
      clientDisplayName: "Test Replay Start",
      cfg: {} as never,
      nowMs: () => 1000,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved: async () => undefined,
    });

    await runtime.start();

    await vi.waitFor(() => {
      expect(deliverRequested).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "abc",
        }),
      );
    });
    pendingDelivery.resolve([{ id: "abc" }]);
    await runtime.stop();
  });

  it("ignores live duplicate approval events after replay", async () => {
    mockReplayLists({ plugin: [createPluginReplayRequest()] });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      label: "test/plugin-replay",
      clientDisplayName: "Test Plugin Replay",
      cfg: {} as never,
      eventKinds: ["plugin"],
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved: async () => undefined,
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(deliverRequested).toHaveBeenCalledTimes(1);
    });
    emitPluginApprovalRequested();
    await Promise.resolve();

    expect(deliverRequested).toHaveBeenCalledTimes(1);
  });

  it("ignores live duplicate approval events while replay delivery is still in flight", async () => {
    mockReplayLists({ plugin: [createPluginReplayRequest()] });
    const pendingDelivery = createDeferred<Array<{ id: string }>>();
    const deliverRequested = vi.fn(async () => pendingDelivery.promise);
    const runtime = createExecApprovalChannelRuntime<
      { id: string },
      PluginApprovalRequest,
      PluginApprovalResolved
    >({
      label: "test/plugin-replay-live-duplicate",
      clientDisplayName: "Test Plugin Replay Live Duplicate",
      cfg: {} as never,
      nowMs: () => 1000,
      eventKinds: ["plugin"],
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved: async () => undefined,
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(deliverRequested).toHaveBeenCalledTimes(1);
    });

    emitPluginApprovalRequested();
    await Promise.resolve();
    expect(deliverRequested).toHaveBeenCalledTimes(1);

    pendingDelivery.resolve([{ id: "plugin:abc" }]);
    await runtime.stop();
  });

  it("does not replay approvals after stop wins once hello is already complete", async () => {
    const replayDeferred = createDeferred<ExecApprovalRequest[]>();
    mockGatewayClientRequests.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return replayDeferred.promise;
      }
      return { ok: true };
    });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/replay-stop-after-ready",
      clientDisplayName: "Test Replay Stop",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved: async () => undefined,
    });

    const startPromise = runtime.start();
    await vi.waitFor(() => {
      expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.list", {});
    });

    const stopPromise = runtime.stop();
    replayDeferred.resolve([createExecReplayRequest()]);

    await startPromise;
    await stopPromise;

    expect(deliverRequested).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalled();
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("waits for in-flight replay delivery before running stopped cleanup", async () => {
    mockReplayLists({ exec: [createExecReplayRequest()] });
    const pendingDelivery = createDeferred<Array<{ id: string }>>();
    const deliverRequested = vi.fn(async () => pendingDelivery.promise);
    const onStopped = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/replay-stop-waits",
      clientDisplayName: "Test Replay Stop Waits",
      cfg: {} as never,
      nowMs: () => 1000,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved: async () => undefined,
      onStopped,
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(deliverRequested).toHaveBeenCalledTimes(1);
    });

    let stopResolved = false;
    const stopPromise = runtime.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(onStopped).not.toHaveBeenCalled();

    pendingDelivery.resolve([{ id: "abc" }]);
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("logs replay delivery failures without failing startup", async () => {
    mockReplayLists({ exec: [createExecReplayRequest()] });
    const runtime = createExecApprovalChannelRuntime({
      label: "test/replay-error",
      clientDisplayName: "Test Replay Error",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested: async () => {
        throw new Error("deliver failed");
      },
      finalizeResolved: async () => undefined,
    });

    await expect(runtime.start()).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(loggerMocks.error).toHaveBeenCalledWith(
        "error replaying pending approvals: deliver failed",
      );
    });
  });

  it("logs replay list failures without failing startup", async () => {
    mockGatewayClientRequests.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        throw new Error("list failed");
      }
      return { ok: true };
    });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/replay-list-error",
      clientDisplayName: "Test Replay List Error",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved: async () => undefined,
    });

    await expect(runtime.start()).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(loggerMocks.error).toHaveBeenCalledWith(
        "error replaying pending approvals: list failed",
      );
    });
    expect(deliverRequested).not.toHaveBeenCalled();
  });

  it("clears pending state when delivery throws", async () => {
    const deliverRequested = vi
      .fn<() => Promise<Array<{ id: string }>>>()
      .mockRejectedValueOnce(new Error("deliver failed"))
      .mockResolvedValueOnce([{ id: "abc" }]);
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createExecApprovalChannelRuntime({
      label: "test/delivery-failure",
      clientDisplayName: "Test Delivery Failure",
      cfg: {} as never,
      isConfigured: () => true,
      shouldHandle: () => true,
      deliverRequested,
      finalizeResolved,
    });

    await expect(
      runtime.handleRequested({
        id: "abc",
        request: {
          command: "echo abc",
        },
        createdAtMs: 1000,
        expiresAtMs: 2000,
      }),
    ).rejects.toThrow("deliver failed");

    await runtime.handleRequested({
      id: "abc",
      request: {
        command: "echo abc",
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });
    await runtime.handleResolved({
      id: "abc",
      decision: "allow-once",
      ts: 1500,
    });

    expect(finalizeResolved).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "abc" }),
      resolved: expect.objectContaining({ id: "abc", decision: "allow-once" }),
      entries: [{ id: "abc" }],
    });
  });
});
