import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// Mock http and https modules before importing the client
vi.mock("node:https", () => {
  const mockRequest = vi.fn();
  const mockGet = vi.fn();
  return { default: { request: mockRequest, get: mockGet }, request: mockRequest, get: mockGet };
});

vi.mock("node:http", () => {
  const mockRequest = vi.fn();
  const mockGet = vi.fn();
  return { default: { request: mockRequest, get: mockGet }, request: mockRequest, get: mockGet };
});

const https = await import("node:https");
let fakeNowMs = 1_700_000_000_000;
let sendMessage: typeof import("./client.js").sendMessage;
let sendFileUrl: typeof import("./client.js").sendFileUrl;
let fetchChatUsers: typeof import("./client.js").fetchChatUsers;
let resolveLegacyWebhookNameToChatUserId: typeof import("./client.js").resolveLegacyWebhookNameToChatUserId;

type RequestCallback = (res: IncomingMessage) => void;
type MockRequestHandler = (
  url: string | URL,
  options: RequestOptions,
  callback?: RequestCallback,
) => ClientRequest;

function createMockResponseEmitter(statusCode: number): IncomingMessage {
  const res = new EventEmitter() as Partial<IncomingMessage>;
  res.statusCode = statusCode;
  return res as IncomingMessage;
}

function createMockRequestEmitter(): ClientRequest {
  const req = new EventEmitter() as Partial<ClientRequest>;
  req.write = vi.fn() as ClientRequest["write"];
  req.end = vi.fn() as ClientRequest["end"];
  req.destroy = vi.fn() as ClientRequest["destroy"];
  return req as ClientRequest;
}

async function settleTimers<T>(promise: Promise<T>): Promise<T> {
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return promise;
}

function mockResponse(statusCode: number, body: string) {
  const httpsRequest = vi.mocked(https.request);
  httpsRequest.mockImplementation(((...args) => {
    const callback = args[2];
    const res = createMockResponseEmitter(statusCode);
    process.nextTick(() => {
      callback?.(res);
      res.emit("data", Buffer.from(body));
      res.emit("end");
    });
    return createMockRequestEmitter();
  }) as MockRequestHandler);
}

function mockSuccessResponse() {
  mockResponse(200, '{"success":true}');
}

function mockFailureResponse(statusCode = 500) {
  mockResponse(statusCode, "error");
}

function installFakeTimerHarness() {
  beforeAll(async () => {
    ({ sendMessage, sendFileUrl, fetchChatUsers, resolveLegacyWebhookNameToChatUserId } =
      await import("./client.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    fakeNowMs += 10_000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

describe("sendMessage", () => {
  installFakeTimerHarness();

  it("returns true on successful send", async () => {
    mockSuccessResponse();
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(true);
  });

  it("returns false on server error after retries", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    expect(result).toBe(false);
  });

  it("includes user_ids when userId is numeric", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello", 42));
    const httpsRequest = vi.mocked(https.request);
    expect(httpsRequest).toHaveBeenCalled();
    const callArgs = httpsRequest.mock.calls[0];
    expect(callArgs[0]).toBe("https://nas.example.com/incoming");
  });

  it("verifies TLS by default", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello"));
    const httpsRequest = vi.mocked(https.request);
    expect(httpsRequest.mock.calls[0]?.[1]).toMatchObject({ rejectUnauthorized: true });
  });

  it("only disables TLS verification when explicitly requested", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello", undefined, true));
    const httpsRequest = vi.mocked(https.request);
    expect(httpsRequest.mock.calls[0]?.[1]).toMatchObject({ rejectUnauthorized: false });
  });
});

describe("sendFileUrl", () => {
  installFakeTimerHarness();

  it("returns true on success", async () => {
    mockSuccessResponse();
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
    );
    expect(result).toBe(true);
  });

  it("returns false on failure", async () => {
    mockFailureResponse(500);
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
    );
    expect(result).toBe(false);
  });

  it("verifies TLS by default", async () => {
    mockSuccessResponse();
    await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
    );
    const httpsRequest = vi.mocked(https.request);
    expect(httpsRequest.mock.calls[0]?.[1]).toMatchObject({ rejectUnauthorized: true });
  });
});

// Helper to mock the user_list API response for fetchChatUsers / resolveLegacyWebhookNameToChatUserId
function mockUserListResponse(
  users: Array<{ user_id: number; username: string; nickname: string }>,
) {
  mockUserListResponseImpl(users, false);
}

function mockUserListResponseOnce(
  users: Array<{ user_id: number; username: string; nickname: string }>,
) {
  mockUserListResponseImpl(users, true);
}

function mockUserListResponseImpl(
  users: Array<{ user_id: number; username: string; nickname: string }>,
  once: boolean,
) {
  const httpsGet = vi.mocked(https.get);
  const impl: MockRequestHandler = (_url, _opts, callback) => {
    const res = createMockResponseEmitter(200);
    process.nextTick(() => {
      callback?.(res);
      res.emit("data", Buffer.from(JSON.stringify({ success: true, data: { users } })));
      res.emit("end");
    });
    return createMockRequestEmitter();
  };
  if (once) {
    httpsGet.mockImplementationOnce(impl);
    return;
  }
  httpsGet.mockImplementation(impl);
}

describe("resolveLegacyWebhookNameToChatUserId", () => {
  const baseUrl =
    "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22";
  const baseUrl2 =
    "https://nas2.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test-2%22";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Advance time to invalidate any cached user list from previous tests
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves user by nickname (webhook username = Chat nickname)", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "jmn" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn",
    });
    expect(result).toBe(4);
  });

  it("resolves user by username when nickname does not match", async () => {
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "" },
      { user_id: 7, username: "she67", nickname: "sarah" },
    ]);
    // Advance time to invalidate cache
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn67",
    });
    expect(result).toBe(4);
  });

  it("is case-insensitive", async () => {
    mockUserListResponse([{ user_id: 4, username: "JMN67", nickname: "JMN" }]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn",
    });
    expect(result).toBe(4);
  });

  it("returns undefined when user is not found", async () => {
    mockUserListResponse([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    const result = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "unknown_user",
    });
    expect(result).toBeUndefined();
  });

  it("uses method=user_list instead of method=chatbot in the API URL", async () => {
    mockUserListResponse([]);
    fakeNowMs += 10 * 60 * 1000;
    vi.setSystemTime(fakeNowMs);
    await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "anyone",
    });
    const httpsGet = vi.mocked(https.get);
    expect(httpsGet).toHaveBeenCalledWith(
      expect.stringContaining("method=user_list"),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("keeps user cache scoped per incoming URL", async () => {
    mockUserListResponseOnce([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    mockUserListResponseOnce([{ user_id: 9, username: "jmn67", nickname: "jmn" }]);

    const result1 = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl,
      mutableWebhookUsername: "jmn",
    });
    const result2 = await resolveLegacyWebhookNameToChatUserId({
      incomingUrl: baseUrl2,
      mutableWebhookUsername: "jmn",
    });

    expect(result1).toBe(4);
    expect(result2).toBe(9);
    const httpsGet = vi.mocked(https.get);
    expect(httpsGet).toHaveBeenCalledTimes(2);
  });
});

describe("fetchChatUsers", () => {
  installFakeTimerHarness();

  it("filters malformed user entries while keeping valid ones", async () => {
    const httpsGet = vi.mocked(https.get);
    httpsGet.mockImplementation(((_url, _opts, callback) => {
      const res = createMockResponseEmitter(200);
      process.nextTick(() => {
        callback?.(res);
        res.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              success: true,
              data: {
                users: [
                  { user_id: 4, username: "jmn67", nickname: "jmn" },
                  { user_id: "bad", username: "broken" },
                ],
              },
            }),
          ),
        );
        res.emit("end");
      });
      return createMockRequestEmitter();
    }) as MockRequestHandler);

    const users = await fetchChatUsers(
      "https://nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22test%22",
    );

    expect(users).toEqual([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
  });

  it("verifies TLS by default for user_list lookups", async () => {
    mockUserListResponse([{ user_id: 4, username: "jmn67", nickname: "jmn" }]);
    const freshUrl =
      "https://fresh-nas.example.com/webapi/entry.cgi?api=SYNO.Chat.External&method=chatbot&version=2&token=%22fresh%22";

    await fetchChatUsers(freshUrl);

    const httpsGet = vi.mocked(https.get);
    expect(httpsGet.mock.calls[0]?.[1]).toMatchObject({ rejectUnauthorized: true });
  });
});
