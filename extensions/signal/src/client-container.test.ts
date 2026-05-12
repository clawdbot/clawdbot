import * as fetchModule from "openclaw/plugin-sdk/fetch-runtime";
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  containerCheck,
  containerRestRequest,
  containerSendMessage,
  containerSendTyping,
  containerSendReceipt,
  containerFetchAttachment,
  containerRpcRequest,
  containerSendReaction,
  containerRemoveReaction,
  streamContainerEvents,
} from "./client-container.js";

// spyOn approach works with vitest forks pool for cross-directory imports
const mockFetch = vi.fn();
const wsMockState = vi.hoisted(() => ({
  behavior: "close" as "close" | "open" | "error" | "unexpected-response",
  urls: [] as string[],
}));

beforeEach(() => {
  vi.spyOn(fetchModule, "resolveFetch").mockReturnValue(mockFetch as unknown as typeof fetch);
  wsMockState.behavior = "close";
  wsMockState.urls = [];
});

function requireFetchCall(index = 0): [RequestInfo | URL, RequestInit] {
  const call = mockFetch.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call ${index}`);
  }
  return call as [RequestInfo | URL, RequestInit];
}

function expectFetchCall(index: number, url: string, method?: string): RequestInit {
  const [actualUrl, init] = requireFetchCall(index);
  expect(actualUrl).toBe(url);
  if (method) {
    expect(init.method).toBe(method);
  }
  return init;
}

function expectFirstFetchCall(url: string, method?: string): RequestInit {
  return expectFetchCall(0, url, method);
}

function parseFetchBody(index = 0): Record<string, unknown> {
  const init = requireFetchCall(index)[1];
  if (typeof init.body !== "string") {
    throw new Error(`expected fetch call ${index} body to be a string`);
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function expectMockLogNotContains(mock: ReturnType<typeof vi.fn>, expected: string): void {
  const messages = mock.mock.calls.map((call) => String(call[0] ?? ""));
  expect(messages.every((message) => !message.includes(expected))).toBe(true);
}

// Minimal WebSocket mock for connection-log assertions.
vi.mock("ws", () => ({
  default: class MockWebSocket {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(url: string | URL) {
      wsMockState.urls.push(String(url));
      setTimeout(() => {
        if (wsMockState.behavior === "open") {
          this.emit("open");
        } else if (wsMockState.behavior === "error") {
          this.emit("error", new Error("WebSocket failed"));
        } else if (wsMockState.behavior === "unexpected-response") {
          this.emit("unexpected-response", {}, { statusCode: 200, statusMessage: "OK" });
        } else {
          this.emit("close", 1000, Buffer.from("done"));
        }
      }, 0);
    }

    on(event: string, callback: (...args: unknown[]) => void) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(callback);
      this.handlers.set(event, handlers);
      return this;
    }

    once(event: string, callback: (...args: unknown[]) => void) {
      const onceCallback = (...args: unknown[]) => {
        this.handlers.set(
          event,
          (this.handlers.get(event) ?? []).filter((handler) => handler !== onceCallback),
        );
        callback(...args);
      };
      return this.on(event, onceCallback);
    }

    close() {
      this.emit("close", 1000, Buffer.from("done"));
    }

    terminate() {}

    private emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  },
}));

describe("containerCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok:true when /v1/about returns 200", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: true, status: 200, error: null });
    expectFirstFetchCall("http://localhost:8080/v1/about", "GET");
  });

  it("returns ok:false when /v1/about returns 404", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: 404, error: "HTTP 404" });
  });

  it("returns ok:false with error message on fetch failure", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const result = await containerCheck("http://localhost:8080");
    expect(result).toEqual({ ok: false, status: null, error: "Network error" });
  });

  it("normalizes base URL by removing trailing slash", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("http://localhost:8080/");
    expectFirstFetchCall("http://localhost:8080/v1/about");
  });

  it("adds http:// prefix when missing", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("localhost:8080");
    expectFirstFetchCall("http://localhost:8080/v1/about");
  });

  it("validates the receive WebSocket when an account is provided", async () => {
    wsMockState.behavior = "open";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({ ok: true, status: 101, error: null });
    expect(wsMockState.urls).toEqual(["ws://localhost:8080/v1/receive/%2B14259798283"]);
  });

  it("rejects container receive endpoints that do not upgrade to WebSocket", async () => {
    wsMockState.behavior = "unexpected-response";
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await containerCheck("http://localhost:8080", 1000, "+14259798283");

    expect(result).toEqual({
      ok: false,
      status: 200,
      error: "Signal container receive endpoint did not upgrade to WebSocket (HTTP 200)",
    });
  });
});

describe("containerRestRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("makes GET request with correct endpoint", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ version: "1.0" }),
    });

    const result = await containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080" });
    expect(result).toEqual({ version: "1.0" });
    const init = expectFirstFetchCall("http://localhost:8080/v1/about", "GET");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("makes POST request with body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "",
    });

    await containerRestRequest("/v2/send", { baseUrl: "http://localhost:8080" }, "POST", {
      message: "test",
      number: "+1234567890",
      recipients: ["+1234567890"],
    });

    const init = expectFirstFetchCall("http://localhost:8080/v2/send", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        message: "test",
        number: "+1234567890",
        recipients: ["+1234567890"],
      }),
    );
  });

  it("parses 201 response bodies", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ timestamp: 1700000000000 }),
    });

    const result = await containerRestRequest(
      "/v2/send",
      { baseUrl: "http://localhost:8080" },
      "POST",
    );
    expect(result).toEqual({ timestamp: 1700000000000 });
  });

  it("returns undefined for 204 status", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerRestRequest(
      "/v1/typing-indicator/+1234567890",
      { baseUrl: "http://localhost:8080" },
      "PUT",
    );
    expect(result).toBeUndefined();
  });

  it("throws error on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Server error details",
    });

    await expect(
      containerRestRequest("/v2/send", { baseUrl: "http://localhost:8080" }, "POST"),
    ).rejects.toThrow("Signal REST 500: Server error details");
  });

  it("handles empty response body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });

    const result = await containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080" });
    expect(result).toBeUndefined();
  });

  it("respects custom timeout by using abort signal", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });

    await containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080", timeoutMs: 5000 });

    // The timeout is enforced via AbortController, so we verify the call was made with a signal
    expect(mockFetch).toHaveBeenCalled();
    if (requireFetchCall()[1].signal === undefined) {
      throw new Error("expected fetch call to include an abort signal");
    }
  });
});

describe("containerSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends message to recipients", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: "1700000000000" }),
    });

    const result = await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Hello world",
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    const init = expectFirstFetchCall("http://localhost:8080/v2/send", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        message: "Hello world",
        number: "+14259798283",
        recipients: ["+15550001111"],
      }),
    );
  });

  it("normalizes invalid send timestamps before returning", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: "not-a-number" }),
    });

    await expect(
      containerSendMessage({
        baseUrl: "http://localhost:8080",
        account: "+14259798283",
        recipients: ["+15550001111"],
        message: "Hello world",
      }),
    ).rejects.toThrow("Signal REST send returned invalid timestamp");
  });

  it("uses container styled text mode when styles are provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Bold text",
      textStyles: [{ start: 0, length: 4, style: "BOLD" }],
    });

    const body = parseFetchBody();
    expect(body.message).toBe("**Bold** text");
    expect(body.text_mode).toBe("styled");
    expect(body).not.toHaveProperty("text_style");
  });

  it("escapes unstyled formatting markers in styled container messages", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Bold * not italic",
      textStyles: [{ start: 0, length: 4, style: "BOLD" }],
    });

    const callArgs = mockFetch.mock.calls.at(0);
    if (callArgs === undefined) {
      throw new Error("expected container fetch call");
    }
    const body = JSON.parse(callArgs[1].body);
    expect(body.message).toBe("**Bold** \\* not italic");
  });

  it("preserves literal backslashes in styled container messages", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Bold C:\\Temp\\file and /foo\\bar/",
      textStyles: [{ start: 0, length: 4, style: "BOLD" }],
    });

    const callArgs = mockFetch.mock.calls.at(0);
    if (callArgs === undefined) {
      throw new Error("expected container fetch call");
    }
    const body = JSON.parse(callArgs[1].body);
    expect(body.message).toBe("**Bold** C:\\Temp\\file and /foo\\bar/");
  });

  it("includes attachments as base64 data URIs", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    // Create a temp file with known content
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-test-"));
    const tmpFile = path.join(tmpDir, "test-image.jpg");
    const content = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
    await fs.writeFile(tmpFile, content);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendMessage({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipients: ["+15550001111"],
      message: "Photo",
      attachments: [tmpFile],
    });

    const callArgs = mockFetch.mock.calls.at(0);
    if (callArgs === undefined) {
      throw new Error("expected container fetch call");
    }
    const body = JSON.parse(callArgs[1].body);
    expect(body.attachments).toBeUndefined();
    if (!Array.isArray(body.base64_attachments)) {
      throw new Error("expected base64 attachments array");
    }
    expect(body.base64_attachments).toHaveLength(1);
    expect(body.base64_attachments[0]).toMatch(
      /^data:image\/jpeg;filename=test-image\.jpg;base64,/,
    );

    // Cleanup
    await fs.rm(tmpDir, { recursive: true });
  });
});

describe("containerSendTyping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends typing indicator with PUT", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerSendTyping({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
    });

    expect(result).toBe(true);
    const init = expectFirstFetchCall(
      "http://localhost:8080/v1/typing-indicator/%2B14259798283",
      "PUT",
    );
    expect(init.body).toBe(JSON.stringify({ recipient: "+15550001111" }));
  });

  it("stops typing indicator with DELETE", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerSendTyping({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      stop: true,
    });

    expect(requireFetchCall()[1].method).toBe("DELETE");
  });
});

describe("containerRpcRequest typing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats group ids for typing indicators", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerRpcRequest(
      "sendTyping",
      {
        account: "+14259798283",
        groupId: "group-123",
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.recipient).toBe("group.Z3JvdXAtMTIz");
  });
});

describe("containerSendReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends read receipt", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    const result = await containerSendReceipt({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      timestamp: 1700000000000,
    });

    expect(result).toBe(true);
    const init = expectFirstFetchCall("http://localhost:8080/v1/receipts/%2B14259798283", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        recipient: "+15550001111",
        timestamp: 1700000000000,
        receipt_type: "read",
      }),
    );
  });

  it("sends viewed receipt when type specified", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerSendReceipt({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      timestamp: 1700000000000,
      type: "viewed",
    });

    const body = parseFetchBody();
    expect(body.receipt_type).toBe("viewed");
  });
});

describe("containerFetchAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches attachment binary", async () => {
    const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => binaryData.buffer,
    });

    const result = await containerFetchAttachment("attachment-123", {
      baseUrl: "http://localhost:8080",
    });

    expect(result).toBeInstanceOf(Buffer);
    expectFirstFetchCall("http://localhost:8080/v1/attachments/attachment-123", "GET");
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });

    const result = await containerFetchAttachment("attachment-123", {
      baseUrl: "http://localhost:8080",
    });

    expect(result).toBeNull();
  });

  it("encodes attachment ID in URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await containerFetchAttachment("path/with/slashes", {
      baseUrl: "http://localhost:8080",
    });

    expectFirstFetchCall("http://localhost:8080/v1/attachments/path%2Fwith%2Fslashes");
  });

  it("rejects attachments above the content-length cap", async () => {
    const arrayBuffer = vi.fn();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "5" }),
      arrayBuffer,
    });

    await expect(
      containerFetchAttachment("attachment-123", {
        baseUrl: "http://localhost:8080",
        maxResponseBytes: 4,
      }),
    ).rejects.toThrow("Signal REST attachment exceeded size limit");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects streamed attachments that exceed the response cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: stream,
    });

    await expect(
      containerFetchAttachment("attachment-123", {
        baseUrl: "http://localhost:8080",
        maxResponseBytes: 4,
      }),
    ).rejects.toThrow("Signal REST attachment exceeded size limit");
  });
});

describe("normalizeBaseUrl edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws error for empty base URL", async () => {
    await expect(containerCheck("")).rejects.toThrow("Signal base URL is required");
  });

  it("throws error for whitespace-only base URL", async () => {
    await expect(containerCheck("   ")).rejects.toThrow("Signal base URL is required");
  });

  it("handles https URLs", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("https://signal.example.com");
    expectFirstFetchCall("https://signal.example.com/v1/about");
  });

  it("handles URLs with ports", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await containerCheck("http://192.168.1.100:9922");
    expectFirstFetchCall("http://192.168.1.100:9922/v1/about");
  });

  it("rejects base URLs with credentials", async () => {
    await expect(containerCheck("http://user:pass@localhost:8080")).rejects.toThrow(
      "Signal base URL must not include credentials",
    );
  });
});

describe("containerRestRequest edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles DELETE method", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
    });

    await containerRestRequest(
      "/v1/some-resource/123",
      { baseUrl: "http://localhost:8080" },
      "DELETE",
    );

    expectFirstFetchCall("http://localhost:8080/v1/some-resource/123", "DELETE");
  });

  it("handles error response with empty body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "",
    });

    await expect(
      containerRestRequest("/v2/send", { baseUrl: "http://localhost:8080" }, "POST"),
    ).rejects.toThrow("Signal REST 500: Internal Server Error");
  });

  it("handles JSON parse errors gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "not-valid-json",
    });

    await expect(
      containerRestRequest("/v1/about", { baseUrl: "http://localhost:8080" }),
    ).rejects.toThrow();
  });
});

describe("streamContainerEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redacts the account from the connection log", async () => {
    const log = vi.fn();

    await streamContainerEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      onEvent: vi.fn(),
      logger: { log },
    });

    expect(log).toHaveBeenCalledWith(
      "[signal-ws] connecting to ws://localhost:8080/v1/receive/<redacted>",
    );
    expectMockLogNotContains(log, "+14259798283");
    expectMockLogNotContains(log, "%2B14259798283");
  });

  it("removes the abort listener when the stream closes", async () => {
    const abortController = new AbortController();
    const addEventListener = vi.spyOn(abortController.signal, "addEventListener");
    const removeEventListener = vi.spyOn(abortController.signal, "removeEventListener");

    await streamContainerEvents({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      abortSignal: abortController.signal,
      onEvent: vi.fn(),
    });

    const abortHandler = addEventListener.mock.calls.find((call) => call[0] === "abort")?.[1];
    expect(abortHandler).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", abortHandler);
  });
});

describe("containerSendReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends reaction to recipient", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: 1700000000000 }),
    });

    const result = await containerSendReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "👍",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    const init = expectFirstFetchCall("http://localhost:8080/v1/reactions/%2B14259798283", "POST");
    expect(init.body).toBe(
      JSON.stringify({
        recipient: "+15550001111",
        reaction: "👍",
        target_author: "+15550001111",
        timestamp: 1699999999999,
      }),
    );
  });

  it("includes group_id when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerSendReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "❤️",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
      groupId: "group-123",
    });

    const body = parseFetchBody();
    expect(body.group_id).toBe("group-123");
  });
});

describe("containerRpcRequest reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes group reactions to the formatted group recipient", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerRpcRequest(
      "sendReaction",
      {
        account: "+14259798283",
        recipients: ["uuid:author-uuid"],
        groupIds: ["group-123"],
        emoji: "👍",
        targetAuthor: "uuid:author-uuid",
        targetTimestamp: 1699999999999,
      },
      { baseUrl: "http://localhost:8080" },
    );

    const body = parseFetchBody();
    expect(body.recipient).toBe("group.Z3JvdXAtMTIz");
    expect(body.group_id).toBe("group.Z3JvdXAtMTIz");
    expect(body.target_author).toBe("author-uuid");
  });
});

describe("containerRemoveReaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes reaction with DELETE", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ timestamp: 1700000000000 }),
    });

    const result = await containerRemoveReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "👍",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
    });

    expect(result).toEqual({ timestamp: 1700000000000 });
    const init = expectFirstFetchCall(
      "http://localhost:8080/v1/reactions/%2B14259798283",
      "DELETE",
    );
    expect(init.body).toBe(
      JSON.stringify({
        recipient: "+15550001111",
        reaction: "👍",
        target_author: "+15550001111",
        timestamp: 1699999999999,
      }),
    );
  });

  it("includes group_id when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });

    await containerRemoveReaction({
      baseUrl: "http://localhost:8080",
      account: "+14259798283",
      recipient: "+15550001111",
      emoji: "❤️",
      targetAuthor: "+15550001111",
      targetTimestamp: 1699999999999,
      groupId: "group-123",
    });

    const body = parseFetchBody();
    expect(body.group_id).toBe("group-123");
  });
});
