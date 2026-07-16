// Signal tests cover client adapter plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  signalRpcRequest as signalRpcRequestImpl,
  signalCheck as signalCheckImpl,
  streamSignalEvents as streamSignalEventsImpl,
  type SignalApiMode,
} from "./client-adapter.js";
const {
  mockNativeCheck,
  mockNativeRpcRequest,
  mockNativeStreamEvents,
  mockContainerCheck,
  mockContainerRpcRequest,
  mockStreamContainerEvents,
} = vi.hoisted(() => ({
  mockNativeCheck: vi.fn(),
  mockNativeRpcRequest: vi.fn(),
  mockNativeStreamEvents: vi.fn(),
  mockContainerCheck: vi.fn(),
  mockContainerRpcRequest: vi.fn(),
  mockStreamContainerEvents: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return {
    ...actual,
    signalCheck: mockNativeCheck,
    signalRpcRequest: mockNativeRpcRequest,
    streamSignalEvents: mockNativeStreamEvents,
  };
});

vi.mock("./client-container.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client-container.js")>();
  return {
    ...actual,
    containerCheck: mockContainerCheck,
    containerRpcRequest: mockContainerRpcRequest,
    streamContainerEvents: mockStreamContainerEvents,
  };
});

let currentApiMode: SignalApiMode = "auto";

afterEach(() => {
  vi.useRealTimers();
});

function setApiMode(mode: SignalApiMode) {
  currentApiMode = mode;
}

function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: Parameters<typeof signalRpcRequestImpl>[2],
) {
  return signalRpcRequestImpl<T>(method, params, { ...opts, apiMode: currentApiMode });
}

function signalCheck(baseUrl: string, timeoutMs?: number) {
  return signalCheckImpl(baseUrl, timeoutMs, { apiMode: currentApiMode });
}

function streamSignalEvents(params: Parameters<typeof streamSignalEventsImpl>[0]) {
  return streamSignalEventsImpl({ ...params, apiMode: currentApiMode });
}

async function detectSignalApiMode(
  baseUrl: string,
  timeoutMs = 10_000,
  options: { account?: string; requireContainerReceive?: boolean } = {},
): Promise<"native" | "container"> {
  if (options.requireContainerReceive) {
    await streamSignalEventsImpl({
      baseUrl,
      account: options.account,
      timeoutMs,
      onEvent: vi.fn(),
      apiMode: "auto",
    });
    return mockStreamContainerEvents.mock.calls.length > 0 ? "container" : "native";
  }
  const result = await signalCheckImpl(baseUrl, timeoutMs, { apiMode: "auto" });
  if (!result.ok) {
    throw new Error(result.error ?? `Signal API not reachable at ${baseUrl}`);
  }
  return mockContainerCheck.mock.calls.length > mockNativeCheck.mock.calls.length
    ? "container"
    : "native";
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value), `${label} should be an object`).toBe(true);
  if (!isRecord(value)) {
    throw new Error(`${label} should be an object`);
  }
  return value;
}

function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const [key, value] of Object.entries(expected)) {
    expect(record[key], key).toEqual(value);
  }
}

function requireMockCall(mock: MockCalls, label: string, index = 0): unknown[] {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`expected ${label} call ${index}`);
  }
  return call;
}

function expectRpcCall(params: {
  mock: MockCalls;
  method: string;
  rpcParams?: Record<string, unknown>;
  options?: Record<string, unknown>;
}) {
  expect(params.mock.mock.calls).toHaveLength(1);
  const [method, rpcParams, options] = requireMockCall(params.mock, "rpc");
  expect(method).toBe(params.method);
  if (params.rpcParams) {
    expectFields(requireRecord(rpcParams, "rpc params"), params.rpcParams);
  } else if (rpcParams === undefined) {
    throw new Error("expected rpc params argument");
  }
  if (params.options) {
    expectFields(requireRecord(options, "rpc options"), params.options);
  } else if (options === undefined) {
    throw new Error("expected rpc options argument");
  }
}

function expectSingleObjectCall(mock: MockCalls, expected: Record<string, unknown>) {
  expect(mock.mock.calls).toHaveLength(1);
  const [payload] = requireMockCall(mock, "single object");
  expectFields(requireRecord(payload, "call payload"), expected);
}

describe("detectSignalApiMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("returns native when native endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false, status: 404 });

    const result = await detectSignalApiMode("http://native-only.local:8080");
    expect(result).toBe("native");
  });

  it("returns container when only container endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://container-only.local:8080");
    expect(result).toBe("container");
  });

  it("prefers native when both endpoints respond", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://both-healthy.local:8080");
    expect(result).toBe("native");
  });

  it("prefers native even when the container probe resolves first", async () => {
    mockNativeCheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, status: 200 }), 1);
        }),
    );
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://container-first.local:8080");
    expect(result).toBe("native");
  });

  it("returns container after the native preference grace when native does not respond", async () => {
    vi.useFakeTimers();
    try {
      mockNativeCheck.mockImplementation(() => new Promise(() => {}));
      mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

      const result = detectSignalApiMode("http://native-stalled.local:8080");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toBe("container");
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws error when neither endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });
    mockContainerCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });

    await expect(detectSignalApiMode("http://neither-healthy.local:8080")).rejects.toThrow(
      "Signal API not reachable at http://neither-healthy.local:8080",
    );
  });

  it("handles exceptions from check functions", async () => {
    mockNativeCheck.mockRejectedValue(new Error("Network error"));
    mockContainerCheck.mockRejectedValue(new Error("Network error"));

    await expect(detectSignalApiMode("http://probe-errors.local:8080")).rejects.toThrow(
      "Signal API not reachable",
    );
  });

  it("respects timeout parameter", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false });

    await detectSignalApiMode("http://custom-timeout.local:8080", 5000);
    expect(mockNativeCheck).toHaveBeenCalledWith("http://custom-timeout.local:8080", 5000);
    expect(mockContainerCheck).toHaveBeenCalledWith("http://custom-timeout.local:8080", 5000);
  });

  it("requires a working container receive WebSocket when requested", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 101 });

    const result = await detectSignalApiMode("http://container-receive.local:8080", 5000, {
      account: "+14259798283",
      requireContainerReceive: true,
    });

    expect(result).toBe("container");
    expect(mockContainerCheck).toHaveBeenCalledWith(
      "http://container-receive.local:8080",
      5000,
      "+14259798283",
    );
  });

  it("does not select container receive mode without an account", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });

    await expect(
      detectSignalApiMode("http://missing-account.local:8080", 5000, {
        requireContainerReceive: true,
      }),
    ).rejects.toThrow("Signal API not reachable");

    expect(mockContainerCheck).not.toHaveBeenCalled();
  });
});

describe("signalRpcRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("routes to native JSON-RPC for native mode", async () => {
    mockNativeRpcRequest.mockResolvedValue({ timestamp: 1700000000000 });

    const result = await signalRpcRequest(
      "send",
      { message: "Hello", account: "+14259798283", recipient: ["+15550001111"] },
      { baseUrl: "http://localhost:8080" },
    );

    expect(result).toEqual({ timestamp: 1700000000000 });
    expectRpcCall({
      mock: mockNativeRpcRequest,
      method: "send",
      rpcParams: { message: "Hello" },
      options: { baseUrl: "http://localhost:8080" },
    });
    expect(mockContainerRpcRequest).not.toHaveBeenCalled();
  });

  it("routes to container RPC for container mode", async () => {
    setApiMode("container");
    mockContainerRpcRequest.mockResolvedValue({ timestamp: 1700000000000 });

    const result = await signalRpcRequest(
      "send",
      { message: "Hello", account: "+14259798283", recipient: ["+15550001111"] },
      { baseUrl: "http://localhost:8080" },
    );

    expect(result).toEqual({ timestamp: 1700000000000 });
    expectRpcCall({
      mock: mockContainerRpcRequest,
      method: "send",
      rpcParams: { message: "Hello" },
      options: { baseUrl: "http://localhost:8080" },
    });
    expect(mockNativeRpcRequest).not.toHaveBeenCalled();
  });

  it("uses explicit apiMode from the active config", async () => {
    setApiMode("native");
    mockContainerRpcRequest.mockResolvedValue({ timestamp: 1700000000000 });

    const result = await signalRpcRequestImpl(
      "send",
      { message: "Hello", account: "+14259798283", recipient: ["+15550001111"] },
      { baseUrl: "http://localhost:8080", apiMode: "container" },
    );

    expect(result).toEqual({ timestamp: 1700000000000 });
    expect(mockContainerRpcRequest).toHaveBeenCalled();
    expect(mockNativeRpcRequest).not.toHaveBeenCalled();
  });

  it("passes all RPC methods through to native", async () => {
    mockNativeRpcRequest.mockResolvedValue({});

    await signalRpcRequest(
      "sendTyping",
      { account: "+1", recipient: ["+2"] },
      { baseUrl: "http://localhost:8080" },
    );
    expectRpcCall({ mock: mockNativeRpcRequest, method: "sendTyping" });
  });

  it("passes all RPC methods through to container", async () => {
    setApiMode("container");
    mockContainerRpcRequest.mockResolvedValue({});

    await signalRpcRequest(
      "sendReceipt",
      { account: "+1", recipient: ["+2"] },
      { baseUrl: "http://localhost:8080" },
    );
    expectRpcCall({ mock: mockContainerRpcRequest, method: "sendReceipt" });
  });
});

describe("signalCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native check for native mode", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await signalCheck("http://localhost:8080");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockNativeCheck).toHaveBeenCalledWith("http://localhost:8080", 10000);
    expect(mockContainerCheck).not.toHaveBeenCalled();
  });

  it("uses container check for container mode", async () => {
    setApiMode("container");
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await signalCheck("http://localhost:8080");

    expect(result).toEqual({ ok: true, status: 200 });
    expect(mockContainerCheck).toHaveBeenCalledWith("http://localhost:8080", 10000);
    expect(mockNativeCheck).not.toHaveBeenCalled();
  });

  it("respects timeout parameter", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true });

    await signalCheck("http://localhost:8080", 5000);

    expect(mockNativeCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
  });

  it("uses the caller timeout for auto detection", async () => {
    setApiMode("auto");
    mockNativeCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });
    mockContainerCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });

    await signalCheck("http://auto-timeout.local:8080", 1000);

    expect(mockNativeCheck).toHaveBeenCalledWith("http://auto-timeout.local:8080", 1000);
    expect(mockContainerCheck).toHaveBeenCalledWith("http://auto-timeout.local:8080", 1000);
  });

  it("returns a retryable failure when auto detection is not ready", async () => {
    setApiMode("auto");
    mockNativeCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });
    mockContainerCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });

    await expect(signalCheck("http://localhost:8080")).resolves.toEqual({
      ok: false,
      status: null,
      error: "Signal API not reachable at http://localhost:8080",
    });
  });

  it("drops cached auto mode when the current clock is not a valid date timestamp", async () => {
    setApiMode("auto");
    vi.spyOn(Date, "now").mockReturnValueOnce(1_700_000_000_000).mockReturnValueOnce(Number.NaN);
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false, status: 404 });

    await expect(signalCheck("http://auto-invalid-clock.local:8080")).resolves.toEqual({
      ok: true,
      status: 200,
    });
    await expect(signalCheck("http://auto-invalid-clock.local:8080")).resolves.toEqual({
      ok: true,
      status: 200,
    });

    expect(mockNativeCheck).toHaveBeenCalledTimes(4);
    expect(mockContainerCheck).toHaveBeenCalledTimes(2);
  });

  it("does not cache auto mode when the expiry timestamp would exceed the valid date range", async () => {
    setApiMode("auto");
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false, status: 404 });

    await expect(signalCheck("http://auto-overflow-clock.local:8080")).resolves.toEqual({
      ok: true,
      status: 200,
    });
    await expect(signalCheck("http://auto-overflow-clock.local:8080")).resolves.toEqual({
      ok: true,
      status: 200,
    });

    expect(mockNativeCheck).toHaveBeenCalledTimes(4);
    expect(mockContainerCheck).toHaveBeenCalledTimes(2);
  });
});

describe("streamSignalEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native SSE for native mode", async () => {
    mockNativeStreamEvents.mockResolvedValue(undefined);

    const onEvent = vi.fn();
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent,
    });

    expectSingleObjectCall(mockNativeStreamEvents, {
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
    });
    expect(mockStreamContainerEvents).not.toHaveBeenCalled();
  });

  it("uses container WebSocket for container mode", async () => {
    setApiMode("container");
    mockStreamContainerEvents.mockResolvedValue(undefined);

    const onEvent = vi.fn();
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent,
    });

    expectSingleObjectCall(mockStreamContainerEvents, {
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
    });
    expect(mockNativeStreamEvents).not.toHaveBeenCalled();
  });

  it("passes native SSE events through unchanged", async () => {
    const payload = { envelope: { sourceNumber: "+1555000111" } };
    mockNativeStreamEvents.mockImplementation(async (params) => {
      params.onEvent({ event: "receive", data: JSON.stringify(payload) });
    });

    const events: unknown[] = [];
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "receive", data: JSON.stringify(payload) });
  });

  it("converts container events to SSE-like receive events", async () => {
    setApiMode("container");
    mockStreamContainerEvents.mockImplementation(async (params) => {
      params.onEvent({ envelope: { sourceNumber: "+1555000111" } });
    });

    const events: unknown[] = [];
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      onEvent: (evt) => events.push(evt),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: "receive",
      data: JSON.stringify({ envelope: { sourceNumber: "+1555000111" } }),
    });
  });

  it("passes abort signal to underlying stream", async () => {
    mockNativeStreamEvents.mockResolvedValue(undefined);

    const abortController = new AbortController();
    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      abortSignal: abortController.signal,
      onEvent: vi.fn(),
    });

    expectSingleObjectCall(mockNativeStreamEvents, {
      abortSignal: abortController.signal,
    });
  });

  it("forwards timeout to native SSE stream", async () => {
    mockNativeStreamEvents.mockResolvedValue(undefined);

    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      timeoutMs: 45000,
      onEvent: vi.fn(),
    });

    expectSingleObjectCall(mockNativeStreamEvents, {
      timeoutMs: 45000,
    });
  });

  it("uses a positive probe timeout while preserving zero stream timeout", async () => {
    setApiMode("auto");
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false, status: 404 });
    mockNativeStreamEvents.mockResolvedValue(undefined);

    await streamSignalEvents({
      baseUrl: "http://zero-timeout.local:8080",
      account: "+14259798283",
      timeoutMs: 0,
      onEvent: vi.fn(),
    });

    expect(mockNativeCheck).toHaveBeenCalledWith("http://zero-timeout.local:8080", 10000);
    expect(mockContainerCheck).toHaveBeenCalledWith(
      "http://zero-timeout.local:8080",
      10000,
      "+14259798283",
    );
    expectSingleObjectCall(mockNativeStreamEvents, {
      timeoutMs: 0,
    });
  });

  it("forwards timeout to container event stream", async () => {
    setApiMode("container");
    mockStreamContainerEvents.mockResolvedValue(undefined);

    await streamSignalEvents({
      baseUrl: "http://localhost:8080",
      timeoutMs: 45000,
      onEvent: vi.fn(),
    });

    expectSingleObjectCall(mockStreamContainerEvents, {
      timeoutMs: 45000,
    });
  });

  it("revalidates an unvalidated cached container mode before streaming", async () => {
    setApiMode("auto");
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: false,
        status: 200,
        error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
      });

    await expect(signalCheck("http://auto-cache.local:8080")).resolves.toEqual({
      ok: true,
      status: 200,
    });

    await expect(
      streamSignalEvents({
        baseUrl: "http://auto-cache.local:8080",
        account: "+14259798283",
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow("Signal API not reachable at http://auto-cache.local:8080");
    expect(mockStreamContainerEvents).not.toHaveBeenCalled();
    expect(mockContainerCheck).toHaveBeenLastCalledWith(
      "http://auto-cache.local:8080",
      10000,
      "+14259798283",
    );
  });

  it("does not reuse a cached container mode for no-account receive streams", async () => {
    setApiMode("auto");
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    await expect(signalCheck("http://auto-cache-no-account.local:8080")).resolves.toEqual({
      ok: true,
      status: 200,
    });

    await expect(
      streamSignalEvents({
        baseUrl: "http://auto-cache-no-account.local:8080",
        onEvent: vi.fn(),
      }),
    ).rejects.toThrow("Signal API not reachable at http://auto-cache-no-account.local:8080");
    expect(mockStreamContainerEvents).not.toHaveBeenCalled();
    expect(mockContainerCheck).toHaveBeenCalledTimes(2);
  });
});
