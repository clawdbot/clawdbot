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
  onRequestTiming?: (this: unknown, timing: GatewayProtocolRequestTiming) => void;
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
    expect(latestFrame(connection)).toMatchObject({ id: "2:same-id", method: "replacement" });
    respond(connection, "1:same-id", { stale: true });
    expect(client.hasPendingRequests).toBe(true);
    respond(connection, "2:same-id", { current: true });
    await expect(replacement).resolves.toEqual({ current: true });

    await expect(client.request("send.failure", {}, { timeoutMs: null })).rejects.toThrow(
      "synthetic send failure",
    );
    expect(latestFrame(connection)).toMatchObject({ id: "3:same-id", method: "send.failure" });
    expect(client.hasPendingRequests).toBe(false);
    client.stop();
  });

  it("keeps concurrent requests distinct when generated IDs contain sequence suffixes", async () => {
    const generatedIds = ["same-id:1", "same-id"];
    const { client, connections } = createRequestHarness({
      createRequestId: () => generatedIds.shift() ?? "same-id",
    });
    const connection = connections[0];
    if (!connection) {
      throw new Error("expected request connection");
    }

    const first = client.request("first", {}, { timeoutMs: null });
    const second = client.request("second", {}, { timeoutMs: null });
    const [firstFrame, secondFrame] = connection.frames;
    if (!firstFrame || !secondFrame) {
      throw new Error("expected concurrent request frames");
    }
    expect(firstFrame.id).not.toBe(secondFrame.id);

    respond(connection, firstFrame.id, { request: "first" });
    respond(connection, secondFrame.id, { request: "second" });
    await expect(first).resolves.toEqual({ request: "first" });
    await expect(second).resolves.toEqual({ request: "second" });
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
    expect(latestFrame(connection)).toMatchObject({ id: "2:same-id", method: "agent" });
    respond(connection, "1:same-id", { status: "accepted", runId: "old" });
    respond(connection, "1:same-id", { status: "ok", runId: "old" });
    expect(onAccepted).not.toHaveBeenCalled();
    expect(client.hasPendingRequests).toBe(true);

    respond(connection, "2:same-id", { status: "accepted", runId: "new" });
    respond(connection, "2:same-id", { status: "ok", runId: "new" });
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
    const trace: string[] = [];
    const sentError = new Error("sent callback failed");
    const acceptedError = new Error("accepted callback failed");
    const timingError = new Error("timing callback failed");
    const timingReceivers: unknown[] = [];
    let timing: GatewayProtocolRequestTiming | undefined;
    let callPropertyReads = 0;
    const onRequestTiming = new Proxy(
      function (this: unknown, value: GatewayProtocolRequestTiming) {
        trace.push("timing");
        timingReceivers.push(this);
        timing = value;
        throw timingError;
      },
      {
        get(target, property, receiver) {
          if (property === "call") {
            callPropertyReads += 1;
            throw new Error("timing callback .call must not be read");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const onCallbackError = vi.fn<(label: string, error: unknown) => void>((label) => {
      trace.push(`error:${label}`);
    });
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
          trace.push("sent");
          throw sentError;
        },
        onAccepted: () => {
          trace.push("accepted");
          throw acceptedError;
        },
      },
    );
    const frame = latestFrame(connection);
    respond(connection, frame.id, { status: "accepted" });
    expect(client.hasPendingRequests).toBe(true);
    nowMs = 25;
    respond(connection, frame.id, { status: "ok" });

    await expect(request).resolves.toEqual({ status: "ok" });
    trace.push("resolved");
    expect(trace).toEqual([
      "sent",
      "error:sent",
      "accepted",
      "error:accepted",
      "timing",
      "error:request timing",
      "resolved",
    ]);
    expect(onCallbackError.mock.calls).toEqual([
      ["sent", sentError],
      ["accepted", acceptedError],
      ["request timing", timingError],
    ]);
    expect(callPropertyReads).toBe(0);
    expect(timingReceivers).toHaveLength(1);
    expect(timingReceivers[0]).toMatchObject({ onTiming: onRequestTiming });
    expect(timing).toEqual({
      id: frame.id,
      method: "agent",
      ok: true,
      durationMs: 15,
      startedAtMs: 10,
      endedAtMs: 25,
    });
    client.stop();
  });

  it("isolates a timing accessor installed through the callback receiver", async () => {
    const timingAccessorError = new Error("timing accessor failed");
    const trace: string[] = [];
    const timingReceivers: unknown[] = [];
    const onRequestTiming = function (this: unknown, timing: GatewayProtocolRequestTiming) {
      trace.push(`timing:${timing.method}`);
      timingReceivers.push(this);
    };
    const onCallbackError = vi.fn<(label: string, error: unknown) => void>((label) => {
      trace.push(`error:${label}`);
    });
    const { client, connections } = createRequestHarness({ onRequestTiming, onCallbackError });
    const connection = connections[0];
    if (!connection) {
      throw new Error("expected request connection");
    }

    const first = client.request("first", {}, { timeoutMs: null });
    respond(connection, latestFrame(connection).id, { first: true });
    await expect(first).resolves.toEqual({ first: true });
    trace.push("resolved:first");
    const timingReceiver = timingReceivers[0];
    if (!timingReceiver || typeof timingReceiver !== "object") {
      throw new Error("expected timing callback receiver");
    }
    Object.defineProperty(timingReceiver, "onTiming", {
      configurable: true,
      get: () => {
        trace.push("get:onTiming");
        throw timingAccessorError;
      },
    });

    const second = client.request("second", {}, { timeoutMs: null });
    respond(connection, latestFrame(connection).id, { second: true });
    await expect(second).resolves.toEqual({ second: true });
    trace.push("resolved:second");

    expect(trace).toEqual([
      "timing:first",
      "resolved:first",
      "get:onTiming",
      "error:request timing",
      "resolved:second",
    ]);
    expect(onCallbackError).toHaveBeenCalledExactlyOnceWith("request timing", timingAccessorError);
    expect(client.hasPendingRequests).toBe(false);
    client.stop();
  });

  it("isolates a falsy timing callback installed through the callback receiver", async () => {
    const trace: string[] = [];
    const callbackErrors: unknown[] = [];
    const onRequestTiming = function (this: unknown, timing: GatewayProtocolRequestTiming) {
      trace.push(`timing:${timing.method}`);
      if (!this || typeof this !== "object") {
        throw new Error("expected timing callback receiver");
      }
      Object.defineProperty(this, "onTiming", { configurable: true, value: false });
    };
    const onCallbackError = vi.fn<(label: string, error: unknown) => void>((label, error) => {
      trace.push(`error:${label}`);
      callbackErrors.push(error);
    });
    const { client, connections } = createRequestHarness({ onRequestTiming, onCallbackError });
    const connection = connections[0];
    if (!connection) {
      throw new Error("expected request connection");
    }

    const firstPayload = { first: true };
    const first = client.request("first", {}, { timeoutMs: null });
    respond(connection, latestFrame(connection).id, firstPayload);
    await expect(first).resolves.toEqual(firstPayload);
    trace.push("resolved:first");

    const secondPayload = { second: true };
    const second = client.request("second", {}, { timeoutMs: null });
    respond(connection, latestFrame(connection).id, secondPayload);
    await expect(second).resolves.toEqual(secondPayload);
    trace.push("resolved:second");

    expect(trace).toEqual([
      "timing:first",
      "resolved:first",
      "error:request timing",
      "resolved:second",
    ]);
    expect(callbackErrors).toHaveLength(1);
    const callbackError = callbackErrors[0];
    expect(callbackError).toBeInstanceOf(TypeError);
    expect(onCallbackError).toHaveBeenCalledExactlyOnceWith("request timing", callbackError);
    expect(client.hasPendingRequests).toBe(false);
    client.stop();
  });

  it("restarts the request sequence when the socket flushes", async () => {
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
    expect(latestFrame(secondConnection)).toMatchObject({ id: "1:same-id", method: "second" });
    respond(secondConnection, "1:same-id", { ok: true });
    await expect(replacement).resolves.toEqual({ ok: true });
    client.stop();
  });

  it("preserves requests started on a replacement socket by a close timing observer", async () => {
    let recoveredRequest: Promise<{ healthy: boolean }> | undefined;
    const { client, connections } = createRequestHarness({
      createRequestId: () => "same-id",
      onRequestTiming: ({ method }) => {
        if (method === "retired") {
          client.start();
          recoveredRequest = client.request("replacement", {}, { timeoutMs: null });
          void recoveredRequest.catch(() => undefined);
        }
      },
    });
    const firstConnection = connections[0];
    if (!firstConnection) {
      throw new Error("expected initial request connection");
    }
    const retired = client.request("retired", {}, { timeoutMs: null });
    void retired.catch(() => undefined);

    firstConnection.close(1012, "service restart");

    const replacementConnection = connections[1];
    if (!replacementConnection) {
      throw new Error("expected replacement request connection");
    }
    expect(latestFrame(replacementConnection)).toMatchObject({
      id: "1:same-id",
      method: "replacement",
    });
    expect(client.connected).toBe(true);
    expect(client.hasPendingRequests).toBe(true);
    respond(replacementConnection, "1:same-id", { healthy: true });

    await expect(retired).rejects.toThrow("gateway closed (1012): service restart");
    await expect(recoveredRequest).resolves.toEqual({ healthy: true });
    expect(client.hasPendingRequests).toBe(false);
    client.stop();
  });
});
