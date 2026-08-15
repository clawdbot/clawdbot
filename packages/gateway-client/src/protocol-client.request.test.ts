import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolRequestTiming,
  type GatewayProtocolSocketHandlers,
} from "./protocol-client.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "./timeouts.js";

type RequestFrame = {
  id: string;
  method: string;
};

type RequestConnection = {
  handlers: GatewayProtocolSocketHandlers;
  frames: RequestFrame[];
  close: (code?: number, reason?: string) => void;
};

function createRequestHarness(options?: {
  createRequestId?: () => string;
  requestTimeoutMs?: number;
  onRequestTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onCallbackError?: (label: string, error: unknown) => void;
  send?: (frame: RequestFrame) => void;
  nowMs?: () => number;
}) {
  const connections: RequestConnection[] = [];
  let nextRequestId = 0;
  const client = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (handlers) => {
      let open = true;
      const frames: RequestFrame[] = [];
      const close = (code = 1000, reason = "") => {
        open = false;
        handlers.close(code, reason);
      };
      connections.push({ handlers, frames, close });
      return {
        isOpen: () => open,
        send: (data) => {
          const frame = JSON.parse(data) as RequestFrame;
          frames.push(frame);
          options?.send?.(frame);
        },
        close,
      };
    },
    createRequestId: options?.createRequestId ?? (() => `request-${++nextRequestId}`),
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
    requestTimeoutMs: options?.requestTimeoutMs,
    onRequestTiming: options?.onRequestTiming,
    onCallbackError: options?.onCallbackError,
    nowMs: options?.nowMs,
  });
  client.start();
  return { client, connections };
}

function latestFrame(connection: RequestConnection): RequestFrame {
  const frame = connection.frames.at(-1);
  if (!frame) {
    throw new Error("expected request frame");
  }
  return frame;
}

function respond(connection: RequestConnection, id: string, payload: unknown, ok = true): void {
  connection.handlers.message(
    JSON.stringify({
      type: "res",
      id,
      ok,
      ...(ok ? { payload } : { error: payload }),
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GatewayProtocolClient requests", () => {
  it.each([
    {
      label: "an explicit finite deadline",
      requestTimeoutMs: undefined,
      requestOptions: { timeoutMs: 25 } satisfies GatewayProtocolRequestOptions,
      expectedTimerMs: 25,
      unbounded: false,
    },
    {
      label: "the client default deadline",
      requestTimeoutMs: 30,
      requestOptions: undefined,
      expectedTimerMs: 30,
      unbounded: false,
    },
    {
      label: "an oversized finite deadline",
      requestTimeoutMs: undefined,
      requestOptions: {
        timeoutMs: Number.MAX_SAFE_INTEGER,
      } satisfies GatewayProtocolRequestOptions,
      expectedTimerMs: MAX_SAFE_TIMEOUT_DELAY_MS,
      unbounded: false,
    },
    {
      label: "an explicit null deadline",
      requestTimeoutMs: 30,
      requestOptions: { timeoutMs: null } satisfies GatewayProtocolRequestOptions,
      expectedTimerMs: null,
      unbounded: true,
    },
    {
      label: "the browser default",
      requestTimeoutMs: undefined,
      requestOptions: undefined,
      expectedTimerMs: null,
      unbounded: true,
    },
  ])(
    "normalizes $label only in the scheduling owner",
    ({ requestTimeoutMs, requestOptions, expectedTimerMs, unbounded }) => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const { client } = createRequestHarness({ requestTimeoutMs });
      const request = client.request("status", {}, requestOptions);
      void request.catch(() => {});

      expect(client.hasUnboundedPendingRequests).toBe(unbounded);
      if (expectedTimerMs === null) {
        expect(setTimeoutSpy).not.toHaveBeenCalled();
      } else {
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), expectedTimerMs);
      }
      client.stop();
    },
  );

  it("reports typed deadlines before and after the send boundary", async () => {
    vi.useFakeTimers();
    const sentHarness = createRequestHarness();
    const sentRequest = sentHarness.client.request("sent.request", {}, { timeoutMs: 5 });
    const sentOutcome = sentRequest.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5);

    await expect(sentOutcome).resolves.toMatchObject({
      code: "CLIENT_TIMEOUT",
      method: "sent.request",
      timeoutMs: 5,
      requestSent: true,
    });

    let deadline: (() => void) | undefined;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: Parameters<typeof setTimeout>[0],
    ) => {
      deadline = callback as () => void;
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    const onSent = vi.fn();
    const unsentHarness = createRequestHarness({ send: () => deadline?.() });
    const unsentRequest = unsentHarness.client.request(
      "unsent.request",
      {},
      { timeoutMs: 5, onSent },
    );

    await expect(unsentRequest).rejects.toMatchObject({
      code: "CLIENT_TIMEOUT",
      method: "unsent.request",
      timeoutMs: 5,
      requestSent: false,
    });
    expect(onSent).not.toHaveBeenCalled();
    expect(unsentHarness.client.hasPendingRequests).toBe(false);
    expect(sentHarness.client.hasPendingRequests).toBe(false);
    sentHarness.client.stop();
    unsentHarness.client.stop();
  });

  it("retires aborted and send-failed IDs before a replacement request", async () => {
    const controller = new AbortController();
    let sendCalls = 0;
    const { client, connections } = createRequestHarness({
      createRequestId: () => "same-id",
      send: () => {
        sendCalls += 1;
        if (sendCalls === 3) {
          throw new Error("synthetic send failure");
        }
      },
    });
    const connection = connections[0];
    if (!connection) {
      throw new Error("expected request connection");
    }
    const aborted = client.request("aborted", {}, { timeoutMs: null, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow("gateway request aborted for aborted");

    const replacement = client.request("replacement", {}, { timeoutMs: null });
    expect(latestFrame(connection)).toMatchObject({ id: "same-id:1", method: "replacement" });
    respond(connection, "same-id", { stale: true });
    expect(client.hasPendingRequests).toBe(true);
    respond(connection, "same-id:1", { current: true });
    await expect(replacement).resolves.toEqual({ current: true });

    await expect(client.request("send.failure", {}, { timeoutMs: null })).rejects.toThrow(
      "synthetic send failure",
    );
    expect(latestFrame(connection)).toMatchObject({ id: "same-id:2", method: "send.failure" });
    expect(client.hasPendingRequests).toBe(false);
    client.stop();
  });

  it("ignores late accepted and final replies after a timeout collision", async () => {
    vi.useFakeTimers();
    const onAccepted = vi.fn();
    const { client, connections } = createRequestHarness({ createRequestId: () => "same-id" });
    const connection = connections[0];
    if (!connection) {
      throw new Error("expected request connection");
    }
    const retired = client.request("agent", {}, { timeoutMs: 5, expectFinal: true, onAccepted });
    const retiredOutcome = retired.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    await expect(retiredOutcome).resolves.toBeInstanceOf(GatewayProtocolRequestTimeoutError);

    const replacement = client.request(
      "agent",
      {},
      { timeoutMs: null, expectFinal: true, onAccepted },
    );
    expect(latestFrame(connection)).toMatchObject({ id: "same-id:1", method: "agent" });
    respond(connection, "same-id", { status: "accepted", runId: "old" });
    respond(connection, "same-id", { status: "ok", runId: "old" });
    expect(onAccepted).not.toHaveBeenCalled();
    expect(client.hasPendingRequests).toBe(true);

    respond(connection, "same-id:1", { status: "accepted", runId: "new" });
    respond(connection, "same-id:1", { status: "ok", runId: "new" });
    await expect(replacement).resolves.toEqual({ status: "ok", runId: "new" });
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({ status: "accepted", runId: "new" });
    client.stop();
  });

  it("keeps authoritative Gateway errors distinct from local deadlines", async () => {
    const { client, connections } = createRequestHarness();
    const connection = connections[0];
    if (!connection) {
      throw new Error("expected request connection");
    }
    const request = client.request("sessions.subscribe", {}, { timeoutMs: 25 });
    const frame = latestFrame(connection);
    respond(
      connection,
      frame.id,
      { code: "FORBIDDEN", message: "subscription rejected", retryable: false },
      false,
    );

    const error = await request.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GatewayProtocolRequestError);
    expect(error).not.toBeInstanceOf(GatewayProtocolRequestTimeoutError);
    expect(error).toMatchObject({ code: "FORBIDDEN", retryable: false });
    client.stop();
  });

  it("isolates callbacks while preserving accepted/final settlement and timing", async () => {
    let nowMs = 10;
    const onRequestTiming = vi.fn<(timing: GatewayProtocolRequestTiming) => void>();
    const onCallbackError = vi.fn<(label: string, error: unknown) => void>();
    const { client, connections } = createRequestHarness({
      nowMs: () => nowMs,
      onRequestTiming,
      onCallbackError,
    });
    const connection = connections[0];
    if (!connection) {
      throw new Error("expected request connection");
    }
    const request = client.request(
      "agent",
      {},
      {
        timeoutMs: null,
        expectFinal: true,
        onSent: () => {
          throw new Error("sent callback failed");
        },
        onAccepted: () => {
          throw new Error("accepted callback failed");
        },
      },
    );
    const frame = latestFrame(connection);
    respond(connection, frame.id, { status: "accepted" });
    expect(client.hasPendingRequests).toBe(true);
    nowMs = 25;
    respond(connection, frame.id, { status: "ok" });

    await expect(request).resolves.toEqual({ status: "ok" });
    expect(onCallbackError.mock.calls.map(([label]) => label)).toEqual(["sent", "accepted"]);
    expect(onRequestTiming).toHaveBeenCalledExactlyOnceWith({
      id: frame.id,
      method: "agent",
      ok: true,
      durationMs: 15,
      startedAtMs: 10,
      endedAtMs: 25,
    });
    client.stop();
  });

  it("clears generation tombstones when the socket flushes", async () => {
    vi.useFakeTimers();
    const { client, connections } = createRequestHarness({ createRequestId: () => "same-id" });
    const firstConnection = connections[0];
    if (!firstConnection) {
      throw new Error("expected first request connection");
    }
    const retired = client.request("first", {}, { timeoutMs: 5 });
    const retiredOutcome = retired.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5);
    await expect(retiredOutcome).resolves.toBeInstanceOf(GatewayProtocolRequestTimeoutError);

    firstConnection.close(1000, "socket generation complete");
    client.start();
    const secondConnection = connections[1];
    if (!secondConnection) {
      throw new Error("expected replacement request connection");
    }
    const replacement = client.request("second", {}, { timeoutMs: null });
    expect(latestFrame(secondConnection)).toMatchObject({ id: "same-id", method: "second" });
    respond(secondConnection, "same-id", { ok: true });
    await expect(replacement).resolves.toEqual({ ok: true });
    client.stop();
  });
});
