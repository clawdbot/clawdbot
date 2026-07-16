import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearProbeCache, FEISHU_PROBE_REQUEST_TIMEOUT_MS, probeFeishu } from "./probe.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const DEFAULT_CREDS = { appId: "cli_123", appSecret: "secret" } as const; // pragma: allowlist secret
const DEFAULT_SUCCESS_RESPONSE = {
  code: 0,
  data: { pingBotInfo: { botName: "TestBot", botID: "ou_abc123" } },
} as const;
const DEFAULT_SUCCESS_RESULT = {
  ok: true,
  appId: "cli_123",
  botName: "TestBot",
  botOpenId: "ou_abc123",
} as const;
const BOT1_RESPONSE = {
  code: 0,
  data: { pingBotInfo: { botName: "Bot1", botID: "ou_1" } },
} as const;

function makeRequestFn(response: Record<string, unknown>) {
  return vi.fn().mockResolvedValue(response);
}

function setupClient(response: Record<string, unknown>) {
  const requestFn = makeRequestFn(response);
  createFeishuClientMock.mockReturnValue({ request: requestFn });
  return requestFn;
}

function setupSuccessClient() {
  return setupClient(DEFAULT_SUCCESS_RESPONSE);
}

async function expectDefaultSuccessResult(
  creds = DEFAULT_CREDS,
  expected: {
    ok: true;
    appId: string;
    botName: string;
    botOpenId: string;
  } = DEFAULT_SUCCESS_RESULT,
) {
  const result = await probeFeishu(creds);
  expect(result).toEqual(expected);
}

async function withFakeTimers(run: () => Promise<void>) {
  vi.useFakeTimers();
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

async function expectErrorResultCached(params: {
  requestFn: ReturnType<typeof vi.fn>;
  expectedError: string;
  ttlMs: number;
}) {
  createFeishuClientMock.mockReturnValue({ request: params.requestFn });

  const first = await probeFeishu(DEFAULT_CREDS);
  const second = await probeFeishu(DEFAULT_CREDS);
  expect(first).toMatchObject({ ok: false, error: params.expectedError });
  expect(second).toMatchObject({ ok: false, error: params.expectedError });
  expect(params.requestFn).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(params.ttlMs + 1);

  await probeFeishu(DEFAULT_CREDS);
  expect(params.requestFn).toHaveBeenCalledTimes(2);
}

async function expectFreshDefaultProbeAfter(
  requestFn: ReturnType<typeof vi.fn>,
  invalidate: () => void,
) {
  await probeFeishu(DEFAULT_CREDS);
  expect(requestFn).toHaveBeenCalledTimes(1);

  invalidate();

  await probeFeishu(DEFAULT_CREDS);
  expect(requestFn).toHaveBeenCalledTimes(2);
}

async function readSequentialDefaultProbePair() {
  const first = await probeFeishu(DEFAULT_CREDS);
  return { first, second: await probeFeishu(DEFAULT_CREDS) };
}

describe("probeFeishu", () => {
  beforeEach(() => {
    clearProbeCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearProbeCache();
  });

  it("returns error when credentials are missing", async () => {
    const result = await probeFeishu();
    expect(result).toEqual({ ok: false, error: "missing credentials (appId, appSecret)" });
  });

  it("returns error when appId is missing", async () => {
    const result = await probeFeishu({ appSecret: "secret" } as never); // pragma: allowlist secret
    expect(result).toEqual({ ok: false, error: "missing credentials (appId, appSecret)" });
  });

  it("returns error when appSecret is missing", async () => {
    const result = await probeFeishu({ appId: "cli_123" } as never);
    expect(result).toEqual({ ok: false, error: "missing credentials (appId, appSecret)" });
  });

  it("returns bot info on successful probe", async () => {
    const requestFn = setupSuccessClient();

    await expectDefaultSuccessResult();
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it("passes the probe timeout to the Feishu request", async () => {
    const requestFn = setupSuccessClient();

    await probeFeishu(DEFAULT_CREDS);

    expect(requestFn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/bot/v1/openclaw_bot/ping",
        data: { needBotInfo: true },
        timeout: FEISHU_PROBE_REQUEST_TIMEOUT_MS,
      }),
    );
  });

  it("returns timeout error when request exceeds timeout", async () => {
    await withFakeTimers(async () => {
      const requestFn = vi.fn().mockImplementation(() => new Promise(() => {}));
      createFeishuClientMock.mockReturnValue({ request: requestFn });

      const promise = probeFeishu(DEFAULT_CREDS, { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await promise;

      expect(result).toMatchObject({ ok: false, error: "probe timed out after 1000ms" });
    });
  });

  it("returns aborted when abort signal is already aborted", async () => {
    createFeishuClientMock.mockClear();
    const abortController = new AbortController();
    abortController.abort();

    const result = await probeFeishu(
      { appId: "cli_123", appSecret: "secret" }, // pragma: allowlist secret
      { abortSignal: abortController.signal },
    );

    expect(result).toMatchObject({ ok: false, error: "probe aborted" });
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });
  it("returns cached result on subsequent calls within TTL", async () => {
    const requestFn = setupSuccessClient();

    const { first, second } = await readSequentialDefaultProbePair();

    expect(first).toEqual(second);
    // Only one API call should have been made
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it("makes a fresh API call after cache expires", async () => {
    await withFakeTimers(async () => {
      const requestFn = setupSuccessClient();

      await expectFreshDefaultProbeAfter(requestFn, () => {
        vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      });
    });
  });

  it("caches failed probe results (API error) for the error TTL", async () => {
    await withFakeTimers(async () => {
      await expectErrorResultCached({
        requestFn: makeRequestFn({ code: 99, msg: "token expired" }),
        expectedError: "API error: token expired",
        ttlMs: 60 * 1000,
      });
    });
  });

  it("caches thrown request errors for the error TTL", async () => {
    await withFakeTimers(async () => {
      await expectErrorResultCached({
        requestFn: vi.fn().mockRejectedValue(new Error("network error")),
        expectedError: "network error",
        ttlMs: 60 * 1000,
      });
    });
  });

  it("caches per account independently", async () => {
    const requestFn = setupClient(BOT1_RESPONSE);

    await probeFeishu({ appId: "cli_aaa", appSecret: "s1" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(1);

    // Different appId should trigger a new API call
    await probeFeishu({ appId: "cli_bbb", appSecret: "s2" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(2);

    // Same appId + appSecret as first call should return cached
    await probeFeishu({ appId: "cli_aaa", appSecret: "s1" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("does not share cache between accounts with same appId but different appSecret", async () => {
    const requestFn = setupClient(BOT1_RESPONSE);

    // First account with appId + secret A
    await probeFeishu({ appId: "cli_shared", appSecret: "secret_aaa" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(1);

    // Second account with same appId but different secret (e.g. after rotation)
    // must NOT reuse the cached result
    await probeFeishu({ appId: "cli_shared", appSecret: "secret_bbb" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("uses accountId for cache key when available", async () => {
    const requestFn = setupClient(BOT1_RESPONSE);

    // Two accounts with same appId+appSecret but different accountIds are cached separately
    await probeFeishu({ accountId: "acct-1", appId: "cli_123", appSecret: "secret" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(1);

    await probeFeishu({ accountId: "acct-2", appId: "cli_123", appSecret: "secret" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(2);

    // Same accountId should return cached
    await probeFeishu({ accountId: "acct-1", appId: "cli_123", appSecret: "secret" }); // pragma: allowlist secret
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("clearProbeCache forces fresh API call", async () => {
    const requestFn = setupSuccessClient();

    await expectFreshDefaultProbeAfter(requestFn, () => {
      clearProbeCache();
    });
  });

  it("handles response with pingBotInfo in data", async () => {
    setupClient({
      code: 0,
      data: { pingBotInfo: { botName: "DataBot", botID: "ou_data" } },
    });

    await expectDefaultSuccessResult(DEFAULT_CREDS, {
      ...DEFAULT_SUCCESS_RESULT,
      botName: "DataBot",
      botOpenId: "ou_data",
    });
  });
});
