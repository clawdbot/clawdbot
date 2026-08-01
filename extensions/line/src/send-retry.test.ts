import { HTTPFetchError } from "@line/bot-sdk";
// Line tests cover send retry and quota visibility behavior.
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  pushMessageMock,
  lineFetchMock,
  getMessageQuotaMock,
  getMessageQuotaConsumptionMock,
  MessagingApiClientMock,
  requireRuntimeConfigMock,
  resolveLineAccountMock,
  resolveLineChannelAccessTokenMock,
  recordChannelActivityMock,
  logVerboseMock,
  warnMock,
  resolvePinnedHostnameWithPolicyMock,
} = vi.hoisted(() => {
  const pushMessageMockLocal = vi.fn();
  const lineFetchMockLocal = vi.fn();
  const getMessageQuotaMockLocal = vi.fn();
  const getMessageQuotaConsumptionMockLocal = vi.fn();
  const MessagingApiClientMockLocal = vi.fn(function () {
    return {
      pushMessage: pushMessageMockLocal,
      replyMessage: vi.fn(),
      showLoadingAnimation: vi.fn(),
      getProfile: vi.fn(),
      getMessageQuota: getMessageQuotaMockLocal,
      getMessageQuotaConsumption: getMessageQuotaConsumptionMockLocal,
    };
  });
  const requireRuntimeConfigMockLocal = vi.fn((cfg: unknown) => cfg ?? {});
  const resolveLineAccountMockLocal = vi.fn(() => ({ accountId: "default" }));
  const resolveLineChannelAccessTokenMockLocal = vi.fn(() => "line-token");
  const recordChannelActivityMockLocal = vi.fn();
  const logVerboseMockLocal = vi.fn();
  const warnMockLocal = vi.fn();
  const resolvePinnedHostnameWithPolicyMockLocal = vi.fn();
  return {
    pushMessageMock: pushMessageMockLocal,
    lineFetchMock: lineFetchMockLocal,
    getMessageQuotaMock: getMessageQuotaMockLocal,
    getMessageQuotaConsumptionMock: getMessageQuotaConsumptionMockLocal,
    MessagingApiClientMock: MessagingApiClientMockLocal,
    requireRuntimeConfigMock: requireRuntimeConfigMockLocal,
    resolveLineAccountMock: resolveLineAccountMockLocal,
    resolveLineChannelAccessTokenMock: resolveLineChannelAccessTokenMockLocal,
    recordChannelActivityMock: recordChannelActivityMockLocal,
    logVerboseMock: logVerboseMockLocal,
    warnMock: warnMockLocal,
    resolvePinnedHostnameWithPolicyMock: resolvePinnedHostnameWithPolicyMockLocal,
  };
});

vi.mock("@line/bot-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@line/bot-sdk")>();
  return {
    ...actual,
    messagingApi: { ...actual.messagingApi, MessagingApiClient: MessagingApiClientMock },
  };
});

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
  return {
    ...actual,
    logVerbose: logVerboseMock,
    warn: warnMock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

let sendModule: typeof import("./send.js");

const LINE_TEST_CFG = {
  channels: {
    line: {
      accounts: {
        default: {},
      },
    },
  },
};

describe("LINE send retry and quota visibility", () => {
  beforeAll(async () => {
    sendModule = await import("./send.js");
  });

  afterAll(() => {
    vi.doUnmock("@line/bot-sdk");
    vi.doUnmock("openclaw/plugin-sdk/plugin-config-runtime");
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./channel-access-token.js");
    vi.doUnmock("openclaw/plugin-sdk/channel-activity-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    pushMessageMock.mockReset();
    lineFetchMock.mockReset();
    getMessageQuotaMock.mockReset();
    getMessageQuotaConsumptionMock.mockReset();
    MessagingApiClientMock.mockReset();
    requireRuntimeConfigMock.mockClear();
    resolveLineAccountMock.mockReset();
    resolveLineChannelAccessTokenMock.mockReset();
    recordChannelActivityMock.mockReset();
    logVerboseMock.mockReset();
    warnMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockReset();

    MessagingApiClientMock.mockImplementation(function () {
      return {
        pushMessage: pushMessageMock,
        replyMessage: vi.fn(),
        showLoadingAnimation: vi.fn(),
        getProfile: vi.fn(),
        getMessageQuota: getMessageQuotaMock,
        getMessageQuotaConsumption: getMessageQuotaConsumptionMock,
      };
    });
    requireRuntimeConfigMock.mockImplementation((cfg: unknown) => cfg ?? LINE_TEST_CFG);
    resolveLineAccountMock.mockReturnValue({ accountId: "default" });
    resolveLineChannelAccessTokenMock.mockReturnValue("line-token");
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
    });
    pushMessageMock.mockResolvedValue({ sentMessages: [{ id: "push" }] });
    lineFetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (typeof init?.body !== "string") {
        throw new Error("LINE test fetch requires a JSON string request body");
      }
      const payload = JSON.parse(init.body);
      const provider = requestUrl.endsWith("/push") ? pushMessageMock : null;
      if (!provider) {
        throw new Error("LINE retry tests only exercise the push endpoint");
      }
      const body = await provider(payload);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", lineFetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const RETRY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function fetchRetryKeys(): Array<string | undefined> {
    return lineFetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string> | undefined)?.["X-Line-Retry-Key"],
    );
  }

  function createLineHttpError(status: number, statusText: string, body: string): HTTPFetchError {
    return new HTTPFetchError(`${status} - ${statusText}`, {
      status,
      statusText,
      headers: new Headers(),
      body,
    });
  }

  it("does not misclassify network SyntaxErrors as provider acceptance", async () => {
    vi.useFakeTimers();
    const failure = new SyntaxError("upstream network decoder failed");
    lineFetchMock.mockRejectedValue(failure);

    const send = sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG });
    const settled = send.then(
      (value) => value,
      (err) => err,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(settled).resolves.toBe(failure);
    expect(isChannelPartialDeliveryError(failure)).toBe(false);
  });

  it("retries transient push failures and reuses one retry key", async () => {
    vi.useFakeTimers();
    lineFetchMock.mockRejectedValueOnce(
      createLineHttpError(503, "Service Unavailable", "upstream restarting"),
    );

    const send = sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(send).resolves.toMatchObject({ chatId: "U123" });

    expect(lineFetchMock).toHaveBeenCalledTimes(2);
    const [firstKey, secondKey] = fetchRetryKeys();
    expect(firstKey).toMatch(RETRY_KEY_PATTERN);
    expect(secondKey).toBe(firstKey);
  });

  it("retries rate-limit 429 responses", async () => {
    vi.useFakeTimers();
    lineFetchMock.mockRejectedValueOnce(
      createLineHttpError(429, "Too Many Requests", "rate limit exceeded"),
    );

    const send = sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(send).resolves.toMatchObject({ chatId: "U123" });

    expect(lineFetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 429 responses with a monthly-limit body", async () => {
    // LINE can return "You have reached your monthly limit." 429s while quota
    // remains (temporary reservation exhaustion), so the body is not a reliable
    // permanent marker; the push retry key keeps retries idempotent.
    vi.useFakeTimers();
    lineFetchMock.mockRejectedValueOnce(
      createLineHttpError(429, "Too Many Requests", "You have reached your monthly limit."),
    );

    const send = sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(send).resolves.toMatchObject({ chatId: "U123" });

    expect(lineFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a definitive 4xx rejection", async () => {
    const error = createLineHttpError(400, "Bad Request", "invalid payload");
    lineFetchMock.mockRejectedValueOnce(error);

    await expect(sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG })).rejects.toBe(
      error,
    );
    expect(lineFetchMock).toHaveBeenCalledOnce();
  });

  it("does not wrap reply sends in retry or a retry key", async () => {
    // Reply tokens are single-use; only the upstream auto-reply fallback may push.
    const error = createLineHttpError(503, "Service Unavailable", "upstream restarting");
    lineFetchMock.mockRejectedValueOnce(error);

    await expect(
      sendModule.sendMessageLine("U123", "Hello", {
        cfg: LINE_TEST_CFG,
        replyToken: "reply-token",
      }),
    ).rejects.toBe(error);
    expect(lineFetchMock).toHaveBeenCalledOnce();
    expect(fetchRetryKeys()).toEqual([undefined]);
  });

  it("uses a fresh retry key per logical push", async () => {
    await sendModule.pushMessagesLine("U123", [{ type: "text", text: "one" }], {
      cfg: LINE_TEST_CFG,
    });
    await sendModule.pushMessagesLine("U123", [{ type: "text", text: "two" }], {
      cfg: LINE_TEST_CFG,
    });

    const [firstKey, secondKey] = fetchRetryKeys();
    expect(firstKey).toMatch(RETRY_KEY_PATTERN);
    expect(secondKey).toMatch(RETRY_KEY_PATTERN);
    expect(secondKey).not.toBe(firstKey);
  });

  it("treats a 409 retry-key conflict as the already-delivered push", async () => {
    // LINE echoes the original acceptance receipt when a retry key was already
    // accepted; the send must resolve so the spool never replays a duplicate.
    vi.useFakeTimers();
    lineFetchMock.mockRejectedValueOnce(
      createLineHttpError(503, "Service Unavailable", "upstream restarting"),
    );
    lineFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "The retry key is already accepted",
          sentMessages: [{ id: "already-delivered" }],
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );

    const send = sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(send).resolves.toMatchObject({
      messageId: "already-delivered",
      chatId: "U123",
    });

    expect(lineFetchMock).toHaveBeenCalledTimes(2);
    const [firstKey, secondKey] = fetchRetryKeys();
    expect(secondKey).toBe(firstKey);
  });

  it.each([
    { label: "an unparseable body", body: "not a json receipt" },
    {
      label: "a body without a receipt",
      body: JSON.stringify({ message: "The retry key is already accepted" }),
    },
  ])("treats a 409 conflict with $label as a delivered partial delivery", async ({ body }) => {
    vi.useFakeTimers();
    lineFetchMock.mockRejectedValueOnce(
      createLineHttpError(503, "Service Unavailable", "upstream restarting"),
    );
    lineFetchMock.mockResolvedValueOnce(
      new Response(body, { status: 409, headers: { "content-type": "application/json" } }),
    );

    const send = sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }).then(
      (value) => value,
      (err) => err,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await send;
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect(lineFetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps reply 409 conflicts as plain HTTP errors", async () => {
    // Only push carries a retry key, so a reply 409 is not an accepted receipt
    // and must surface as a normal provider rejection.
    lineFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "conflict" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      sendModule.sendMessageLine("U123", "Hello", {
        cfg: LINE_TEST_CFG,
        replyToken: "reply-token",
      }),
    ).rejects.toBeInstanceOf(HTTPFetchError);
    expect(lineFetchMock).toHaveBeenCalledOnce();
    expect(fetchRetryKeys()).toEqual([undefined]);
  });

  it("gives up after the configured retry budget for persistent failures", async () => {
    vi.useFakeTimers();
    const error = createLineHttpError(503, "Service Unavailable", "upstream restarting");
    lineFetchMock.mockRejectedValue(error);

    const send = sendModule.pushMessageLine("U123", "Hello", { cfg: LINE_TEST_CFG }).then(
      (value) => value,
      (err) => err,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const rejected = await send;
    expect(rejected).toBe(error);
    expect(lineFetchMock).toHaveBeenCalledTimes(5);
    expect(new Set(fetchRetryKeys()).size).toBe(1);
  });

  it("logs limited quota consumption at startup", async () => {
    getMessageQuotaMock.mockResolvedValue({ type: "limited", value: 10_000 });
    getMessageQuotaConsumptionMock.mockResolvedValue({ totalUsage: 2500 });

    await sendModule.logLineChannelQuota({ cfg: LINE_TEST_CFG });

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: quota type=limited, 2500/10000 used (7500 remaining, 25%)",
    );
    expect(warnMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing limit value",
      quota: { type: "limited", value: undefined },
      usage: 2500,
      expected: "line: quota type=limited, 2500/0 used (-2500 remaining, 0%)",
    },
    {
      label: "usage beyond the limit",
      quota: { type: "limited", value: 100 },
      usage: 250,
      expected: "line: quota type=limited, 250/100 used (-150 remaining, 250%)",
    },
  ])(
    "warns about exhausted quota for $label without NaN percentages",
    async ({ quota, usage, expected }) => {
      getMessageQuotaMock.mockResolvedValue(quota);
      getMessageQuotaConsumptionMock.mockResolvedValue({ totalUsage: usage });

      await sendModule.logLineChannelQuota({ cfg: LINE_TEST_CFG });

      expect(warnMock).toHaveBeenCalledWith(expected);
      expect(logVerboseMock).not.toHaveBeenCalledWith(expected);
    },
  );

  it("logs unlimited quota plans at startup", async () => {
    getMessageQuotaMock.mockResolvedValue({ type: "none" });

    await sendModule.logLineChannelQuota({ cfg: LINE_TEST_CFG });

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: quota type=none (unlimited plan, no monthly cap)",
    );
  });

  it("keeps quota probe failures non-fatal", async () => {
    getMessageQuotaMock.mockRejectedValue(new Error("quota unavailable"));

    await expect(sendModule.logLineChannelQuota({ cfg: LINE_TEST_CFG })).resolves.toBeUndefined();

    expect(logVerboseMock).toHaveBeenCalledWith(
      "line: failed to query quota info (non-fatal): Error: quota unavailable",
    );
  });
});
