import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

const ssrfMocks = {
  resolvePinnedHostnameWithPolicy: vi.fn(),
};

// Mock http and https modules before importing the client
vi.mock("node:https", () => {
  const httpsRequest = vi.fn();
  const httpsGet = vi.fn();
  const httpsModule = { request: httpsRequest, get: httpsGet };
  return { default: httpsModule, request: httpsRequest, get: httpsGet };
});

vi.mock("node:http", () => {
  const httpRequest = vi.fn();
  const httpGet = vi.fn();
  return { default: { request: httpRequest, get: httpGet }, request: httpRequest, get: httpGet };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  formatErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

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
type MockHttpCall = [
  string | URL,
  RequestOptions & { rejectUnauthorized?: boolean },
  RequestCallback?,
];

function firstHttpsRequestCall(label = "Synology Chat HTTPS request"): MockHttpCall {
  const call = vi.mocked(https.request).mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call as MockHttpCall;
}

function firstHttpsGetCall(label = "Synology Chat HTTPS get"): MockHttpCall {
  const call = vi.mocked(https.get).mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call as MockHttpCall;
}

function createMockResponseEmitter(statusCode: number): IncomingMessage {
  const res = new EventEmitter() as Partial<IncomingMessage>;
  res.statusCode = statusCode;
  return res as unknown as IncomingMessage;
}

function createMockRequestEmitter(): ClientRequest {
  const req = new EventEmitter() as Partial<ClientRequest>;
  req.write = vi.fn() as ClientRequest["write"];
  req.end = vi.fn() as ClientRequest["end"];
  req.destroy = vi.fn() as ClientRequest["destroy"];
  return req as unknown as ClientRequest;
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
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

const tlsVerificationDefaultCases = [
  {
    name: "sendMessage",
    invoke: () => sendMessage("https://nas.example.com/incoming", "Hello"),
  },
  {
    name: "sendFileUrl",
    invoke: () => sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png"),
  },
];

describe("Synology Chat TLS verification defaults", () => {
  installFakeTimerHarness();

  it.each(tlsVerificationDefaultCases)("$name verifies TLS by default", async ({ invoke }) => {
    mockSuccessResponse();
    await settleTimers(invoke());
    const firstCall = firstHttpsRequestCall();
    expect(firstCall[1]?.rejectUnauthorized).toBe(true);
  });
});

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
    expect(vi.mocked(https.request)).toHaveBeenCalled();
    const callArgs = firstHttpsRequestCall();
    expect(callArgs[0]).toBe("https://nas.example.com/incoming");
  });

  it("only disables TLS verification when explicitly requested", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "Hello", undefined, true));
    const firstCall = firstHttpsRequestCall();
    expect(firstCall[1]?.rejectUnauthorized).toBe(false);
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

  it("respects the shared send interval before posting a file URL", async () => {
    mockSuccessResponse();
    await settleTimers(sendMessage("https://nas.example.com/incoming", "hello"));
    vi.mocked(https.request).mockClear();

    const promise = sendFileUrl("https://nas.example.com/incoming", "https://example.com/file.png");
    await Promise.resolve();
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed file URLs before making a request", async () => {
    const result = await settleTimers(sendFileUrl("https://nas.example.com/incoming", "not-a-url"));
    expect(result).toBe(false);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();
  });

  it("rejects non-http file URLs before making a request", async () => {
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "file:///tmp/secret.txt"),
    );
    expect(result).toBe(false);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).not.toHaveBeenCalled();
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();
  });

  it("rejects SSRF-blocked hosts before making a request", async () => {
    ssrfMocks.resolvePinnedHostnameWithPolicy.mockRejectedValueOnce(
      new Error("Blocked private network target"),
    );
    const result = await settleTimers(
      sendFileUrl("https://nas.example.com/incoming", "http://169.254.169.254/latest/meta-data"),
    );
    expect(result).toBe(false);
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("169.254.169.254");
    expect(vi.mocked(https.request)).not.toHaveBeenCalled();
  });
});

// Helper to mock the user_list API response for fetchChatUsers / resolveLegacyWebhookNameToChatUserId
function mockUserListResponse(users: Array<Record<string, unknown>>) {
  mockUserListResponseImpl(users, false);
}

function mockUserListResponseOnce(users: Array<Record<string, unknown>>) {
  mockUserListResponseImpl(users, true);
}

function mockUserListResponseImpl(users: Array<Record<string, unknown>>, once: boolean) {
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
    const call = firstHttpsGetCall("Synology Chat user_list request");
    expect(String(call[0])).toBe(baseUrl.replace("method=chatbot", "method=user_list"));
    expect(call[1]).toEqual({ rejectUnauthorized: true });
    expect(typeof call[2]).toBe("function");
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
    mockUserListResponse([
      { user_id: 4, username: "jmn67", nickname: "jmn" },
      { user_id: "bad", username: "broken" },
    ]);

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

    const firstCall = firstHttpsGetCall();
    expect(firstCall[1]?.rejectUnauthorized).toBe(true);
  });
});
