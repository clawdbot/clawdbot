// Line tests cover push retry and retry-key deduplication behavior.
import { HTTPFetchError } from "@line/bot-sdk";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLineNonDispatchRetryable, runLinePushWithRetries } from "./send-retry.js";

const {
  requireRuntimeConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
  logVerboseMock,
} = vi.hoisted(() => ({
  requireRuntimeConfigMock: vi.fn((cfg: unknown) => cfg ?? {}),
  resolveLineAccountMock: vi.fn(() => ({ accountId: "default" })),
  resolveLineChannelAccessTokenMock: vi.fn(() => "test-token-placeholder"),
  recordChannelActivityMock: vi.fn(),
  logVerboseMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", () => ({
  requireRuntimeConfig: requireRuntimeConfigMock,
}));

vi.mock("./accounts.js", () => ({
  resolveLineAccount: resolveLineAccountMock,
}));

vi.mock("./channel-access-token.js", () => ({
  resolveLineChannelAccessToken: resolveLineChannelAccessTokenMock,
}));

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", () => ({
  recordChannelActivity: recordChannelActivityMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return { ...actual, logVerbose: logVerboseMock };
});

let sendModule: typeof import("./send.js");

const LINE_TEST_CFG = {
  channels: { line: { accounts: { default: {} } } },
} satisfies OpenClawConfig;
const LINE_TARGET = "line:user:U0123456789abcdef0123456789abcdef";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function transportFailure(code: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(`socket ${code}`), { code }),
  });
}

function retryKeysOf(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): (string | null)[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("X-Line-Retry-Key"));
}

describe("LINE push retries", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(async () => {
    sendModule = await import("./send.js");
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    requireRuntimeConfigMock.mockImplementation((cfg: unknown) => cfg ?? LINE_TEST_CFG);
    resolveLineAccountMock.mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReturnValue("test-token-placeholder");
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function resolveRetryRun<T>(run: Promise<T>): Promise<T> {
    run.catch(() => {});
    await vi.runAllTimersAsync();
    return await run;
  }

  function pushText(text = "hello") {
    return sendModule.pushMessagesLine(LINE_TARGET, [{ type: "text", text }], {
      cfg: LINE_TEST_CFG,
    });
  }

  it("retries a LINE server error under one retry key and delivers once", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "Internal server error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ sentMessages: [{ id: "delivered-1" }] }));

    const result = await resolveRetryRun(pushText());

    expect(result.messageId).toBe("delivered-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryKeys = retryKeysOf(fetchMock);
    expect(retryKeys[0]).toMatch(UUID_PATTERN);
    expect(retryKeys[1]).toBe(retryKeys[0]);
    expect(recordChannelActivityMock).toHaveBeenCalledTimes(1);
  });

  it("keys each push separately so an unrelated send cannot be deduplicated away", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ sentMessages: [{ id: "delivered-1" }] }),
    );

    await resolveRetryRun(pushText("first"));
    await resolveRetryRun(pushText("second"));

    const [firstKey, secondKey] = retryKeysOf(fetchMock);
    expect(firstKey).toMatch(UUID_PATTERN);
    expect(secondKey).toMatch(UUID_PATTERN);
    expect(secondKey).not.toBe(firstKey);
  });

  it("retries a transport failure and keeps the accepted delivery when LINE reports a conflict", async () => {
    fetchMock.mockRejectedValueOnce(transportFailure("ETIMEDOUT")).mockResolvedValueOnce(
      jsonResponse(
        {
          message: "The retry key is already accepted",
          sentMessages: [{ id: "accepted-earlier" }],
        },
        409,
      ),
    );

    const result = await resolveRetryRun(pushText());

    // The first attempt landed even though its outcome never reached us, so the
    // accepted request's message id is the delivery — not a second send.
    expect(result.messageId).toBe("accepted-earlier");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Set(retryKeysOf(fetchMock)).size).toBe(1);
  });

  it("gives up after the configured attempts and surfaces the LINE failure", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({ message: "Internal server error" }, 500),
    );

    await expect(resolveRetryRun(pushText())).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(retryKeysOf(fetchMock)).size).toBe(1);
  });

  it.each([
    { label: "quota rejection", status: 429, message: "You have reached your monthly limit." },
    { label: "request rejection", status: 400, message: "The request body has 1 error(s)" },
  ])("does not retry a LINE $label", async ({ status, message }) => {
    fetchMock.mockResolvedValue(jsonResponse({ message }, status));

    await expect(resolveRetryRun(pushText())).rejects.toBeInstanceOf(HTTPFetchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry once LINE accepted a request with an unreadable receipt", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ sentMessages: [{}] }));

    await expect(resolveRetryRun(pushText())).rejects.toSatisfy(isChannelPartialDeliveryError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries a reply, which LINE cannot deduplicate", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "Internal server error" }, 500));

    await expect(
      resolveRetryRun(
        sendModule.replyMessageLine("reply-token", [{ type: "text", text: "hello" }], {
          cfg: LINE_TEST_CFG,
        }),
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retryKeysOf(fetchMock)).toEqual([null]);
  });
});

describe("resolveLineNonDispatchRetryable", () => {
  const httpError = (status: number) =>
    new HTTPFetchError(`${status} - provider answered`, {
      status,
      statusText: "provider answered",
      headers: new Headers(),
      body: "provider body",
    });

  it.each([
    { label: "a rejected payload", error: httpError(400), retryable: false },
    { label: "a forbidden recipient", error: httpError(403), retryable: false },
    { label: "an unknown recipient", error: httpError(404), retryable: false },
    { label: "a request timeout", error: httpError(408), retryable: undefined },
    { label: "a rate limit", error: httpError(429), retryable: true },
    { label: "an upstream failure", error: httpError(503), retryable: undefined },
    {
      label: "a transport failure that never reached LINE",
      error: new Error("fetch failed"),
      retryable: undefined,
    },
    {
      label: "a rejected payload behind an SDK wrapper",
      error: new Error("send failed", { cause: httpError(400) }),
      retryable: false,
    },
  ])("classifies $label with retryable=$retryable", ({ error, retryable }) => {
    expect(resolveLineNonDispatchRetryable(error)).toBe(retryable);
  });

  it("keeps a push ambiguous when an earlier attempt never reached LINE", async () => {
    const rejected = httpError(400);
    let attempt = 0;
    const failure = await runLinePushWithRetries(async () => {
      attempt += 1;
      // A reset connection may already have delivered the push, so the retry
      // that follows cannot prove it was never sent.
      throw attempt === 1
        ? Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
        : rejected;
    }, "line:push").catch((error: unknown) => error);

    expect(attempt).toBeGreaterThan(1);
    expect(resolveLineNonDispatchRetryable(failure)).toBeUndefined();
  });

  it("still proves a push was refused when LINE rejected the only attempt", async () => {
    let attempt = 0;
    const failure = await runLinePushWithRetries(async () => {
      attempt += 1;
      throw httpError(400);
    }, "line:push").catch((error: unknown) => error);

    expect(attempt).toBe(1);
    expect(resolveLineNonDispatchRetryable(failure)).toBe(false);
  });
});
