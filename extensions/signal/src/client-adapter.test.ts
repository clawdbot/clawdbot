import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  signalRpcRequest as signalRpcRequestImpl,
  detectSignalApiMode,
  signalCheck as signalCheckImpl,
  streamSignalEvents as streamSignalEventsImpl,
  fetchAttachment as fetchAttachmentImpl,
  type SignalApiMode,
} from "./client-adapter.js";
import * as containerClientModule from "./client-container.js";
import * as nativeClientModule from "./client.js";

const mockNativeCheck = vi.fn();
const mockNativeRpcRequest = vi.fn();
const mockNativeStreamEvents = vi.fn();
const mockContainerCheck = vi.fn();
const mockContainerRpcRequest = vi.fn();
const mockContainerFetchAttachment = vi.fn();
const mockStreamContainerEvents = vi.fn();
let currentApiMode: SignalApiMode = "auto";

beforeEach(() => {
  vi.spyOn(nativeClientModule, "signalCheck").mockImplementation(mockNativeCheck as any);
  vi.spyOn(nativeClientModule, "signalRpcRequest").mockImplementation(mockNativeRpcRequest as any);
  vi.spyOn(nativeClientModule, "streamSignalEvents").mockImplementation(
    mockNativeStreamEvents as any,
  );
  vi.spyOn(containerClientModule, "containerCheck").mockImplementation(mockContainerCheck as any);
  vi.spyOn(containerClientModule, "containerRpcRequest").mockImplementation(
    mockContainerRpcRequest as any,
  );
  vi.spyOn(containerClientModule, "containerFetchAttachment").mockImplementation(
    mockContainerFetchAttachment as any,
  );
  vi.spyOn(containerClientModule, "streamContainerEvents").mockImplementation(
    mockStreamContainerEvents as any,
  );
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

function fetchAttachment(params: Parameters<typeof fetchAttachmentImpl>[0]) {
  return fetchAttachmentImpl({ ...params, apiMode: currentApiMode });
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

function expectRpcCall(params: {
  mock: MockCalls;
  method: string;
  rpcParams?: Record<string, unknown>;
  options?: Record<string, unknown>;
}) {
  expect(params.mock.mock.calls).toHaveLength(1);
  const [method, rpcParams, options] = params.mock.mock.calls[0] ?? [];
  expect(method).toBe(params.method);
  if (params.rpcParams) {
    expectFields(requireRecord(rpcParams, "rpc params"), params.rpcParams);
  } else {
    expect(rpcParams).toBeDefined();
  }
  if (params.options) {
    expectFields(requireRecord(options, "rpc options"), params.options);
  } else {
    expect(options).toBeDefined();
  }
}

function expectSingleObjectCall(mock: MockCalls, expected: Record<string, unknown>) {
  expect(mock.mock.calls).toHaveLength(1);
  const [payload] = mock.mock.calls[0] ?? [];
  expectFields(requireRecord(payload, "call payload"), expected);
}

function expectContainerFetchCall(expected: Record<string, unknown>) {
  expect(mockContainerFetchAttachment.mock.calls).toHaveLength(1);
  const [attachmentId, options] = mockContainerFetchAttachment.mock.calls[0] ?? [];
  expect(attachmentId).toBe("attachment-123");
  expectFields(requireRecord(options, "container fetch options"), expected);
}

describe("detectSignalApiMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("returns native when native endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false, status: 404 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("native");
  });

  it("returns container when only container endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("container");
  });

  it("prefers native when both endpoints respond", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 200 });

    const result = await detectSignalApiMode("http://localhost:8080");
    expect(result).toBe("native");
  });

  it("throws error when neither endpoint responds", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });
    mockContainerCheck.mockResolvedValue({ ok: false, status: null, error: "Connection refused" });

    await expect(detectSignalApiMode("http://localhost:8080")).rejects.toThrow(
      "Signal API not reachable at http://localhost:8080",
    );
  });

  it("handles exceptions from check functions", async () => {
    mockNativeCheck.mockRejectedValue(new Error("Network error"));
    mockContainerCheck.mockRejectedValue(new Error("Network error"));

    await expect(detectSignalApiMode("http://localhost:8080")).rejects.toThrow(
      "Signal API not reachable",
    );
  });

  it("respects timeout parameter", async () => {
    mockNativeCheck.mockResolvedValue({ ok: true, status: 200 });
    mockContainerCheck.mockResolvedValue({ ok: false });

    await detectSignalApiMode("http://localhost:8080", 5000);
    expect(mockNativeCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
    expect(mockContainerCheck).toHaveBeenCalledWith("http://localhost:8080", 5000);
  });

  it("requires a working container receive WebSocket when requested", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });
    mockContainerCheck.mockResolvedValue({ ok: true, status: 101 });

    const result = await detectSignalApiMode("http://localhost:8080", 5000, {
      account: "+14259798283",
      requireContainerReceive: true,
    });

    expect(result).toBe("container");
    expect(mockContainerCheck).toHaveBeenCalledWith("http://localhost:8080", 5000, "+14259798283");
  });

  it("does not select container receive mode without an account", async () => {
    mockNativeCheck.mockResolvedValue({ ok: false, status: 404 });

    await expect(
      detectSignalApiMode("http://localhost:8080", 5000, {
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
});

describe("fetchAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setApiMode("native");
  });

  it("uses native JSON-RPC for native mode with sender", async () => {
    mockNativeRpcRequest.mockResolvedValue({ data: "base64data" });

    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      attachmentId: "attachment-123",
      sender: "+15550001111",
    });

    expect(result).toBeInstanceOf(Buffer);
    expectRpcCall({
      mock: mockNativeRpcRequest,
      method: "getAttachment",
      rpcParams: {
        id: "attachment-123",
        account: "+14259798283",
        recipient: "+15550001111",
      },
    });
  });

  it("uses container REST for container mode", async () => {
    setApiMode("container");
    const mockBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mockContainerFetchAttachment.mockResolvedValue(mockBuffer);

    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
    });

    expect(result).toBe(mockBuffer);
    expectContainerFetchCall({ baseUrl: "http://localhost:8080" });
  });

  it("returns null for native mode without sender or groupId", async () => {
    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
    });

    expect(result).toBeNull();
    expect(mockNativeRpcRequest).not.toHaveBeenCalled();
  });

  it("uses groupId when provided for native mode", async () => {
    mockNativeRpcRequest.mockResolvedValue({ data: "base64data" });

    await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      groupId: "group-123",
    });

    expectRpcCall({
      mock: mockNativeRpcRequest,
      method: "getAttachment",
      rpcParams: { groupId: "group-123" },
    });
  });

  it("returns null when native RPC returns no data", async () => {
    mockNativeRpcRequest.mockResolvedValue({});

    const result = await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      sender: "+15550001111",
    });

    expect(result).toBeNull();
  });

  it("prefers groupId over sender when both provided", async () => {
    mockNativeRpcRequest.mockResolvedValue({ data: "base64data" });

    await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      sender: "+15550001111",
      groupId: "group-123",
    });

    const callParams = mockNativeRpcRequest.mock.calls[0][1];
    expect(callParams).toHaveProperty("groupId", "group-123");
    expect(callParams).not.toHaveProperty("recipient");
  });

  it("passes timeout to container fetch", async () => {
    setApiMode("container");
    mockContainerFetchAttachment.mockResolvedValue(Buffer.from([]));

    await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      timeoutMs: 60000,
    });

    expectContainerFetchCall({ timeoutMs: 60000 });
  });

  it("passes max response bytes to container fetch", async () => {
    setApiMode("container");
    mockContainerFetchAttachment.mockResolvedValue(Buffer.from([]));

    await fetchAttachment({
      baseUrl: "http://localhost:8080",
      attachmentId: "attachment-123",
      maxResponseBytes: 4096,
    });

    expectContainerFetchCall({ maxResponseBytes: 4096 });
  });
});
