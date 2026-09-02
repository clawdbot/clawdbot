// Feishu tests cover probe plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { probeFeishu, registerFeishuAiAgent } from "./probe.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const FEISHU_PROBE_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CREDS = { accountId: "probe-0", appId: "cli_123", appSecret: "secret" }; // pragma: allowlist secret
let defaultAccountSequence = 0;
const DEFAULT_SUCCESS_RESPONSE = {
  code: 0,
  bot: { app_name: "TestBot", open_id: "ou_abc123" },
} as const;
const DEFAULT_SUCCESS_RESULT = {
  ok: true,
  appId: "cli_123",
  botName: "TestBot",
  botOpenId: "ou_abc123",
} as const;
const BOT1_RESPONSE = {
  code: 0,
  bot: { app_name: "Bot1", open_id: "ou_1" },
} as const;

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.resetModules();
});

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
  const expected = { ok: false, appId: DEFAULT_CREDS.appId, error: params.expectedError };
  expect(first).toEqual(expected);
  expect(second).toEqual(expected);
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
    defaultAccountSequence += 1;
    DEFAULT_CREDS.accountId = `probe-${defaultAccountSequence}`;
    vi.restoreAllMocks();
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

    expect(requestFn).toHaveBeenCalledWith({
      method: "GET",
      url: "/open-apis/bot/v3/info",
      timeout: FEISHU_PROBE_REQUEST_TIMEOUT_MS,
    });
  });

  it("returns timeout error when request exceeds timeout", async () => {
    await withFakeTimers(async () => {
      const requestFn = vi.fn().mockImplementation(() => new Promise(() => {}));
      createFeishuClientMock.mockReturnValue({ request: requestFn });

      const promise = probeFeishu(DEFAULT_CREDS, { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await promise;

      expect(result).toEqual({
        ok: false,
        appId: DEFAULT_CREDS.appId,
        error: "probe timed out after 1000ms",
      });
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

    expect(result).toEqual({ ok: false, appId: "cli_123", error: "probe aborted" });
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });
  it("returns cached result on subsequent calls within TTL", async () => {
    const requestFn = setupSuccessClient();

    const { first, second } = await readSequentialDefaultProbePair();

    expect(first).toEqual(second);
    // Only one API call should have been made
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it("does not cache probe results when the expiry would exceed a valid Date", async () => {
    await withFakeTimers(async () => {
      vi.setSystemTime(new Date(8_640_000_000_000_000));
      const requestFn = setupSuccessClient();

      const { first, second } = await readSequentialDefaultProbePair();

      expect(first).toEqual(second);
      expect(requestFn).toHaveBeenCalledTimes(2);
    });
  });

  it("evicts cached probe results when the current clock is invalid", async () => {
    const requestFn = setupSuccessClient();

    await probeFeishu(DEFAULT_CREDS);
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      await probeFeishu(DEFAULT_CREDS);
    } finally {
      dateNow.mockRestore();
    }

    expect(requestFn).toHaveBeenCalledTimes(2);
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

  it("rejects a successful standard response without bot identity", async () => {
    setupClient({ code: 0, bot: { app_name: "MissingId" } });

    await expect(probeFeishu(DEFAULT_CREDS)).resolves.toEqual({
      ok: false,
      appId: DEFAULT_CREDS.appId,
      error: "API response missing bot open_id",
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

  it("does not reuse cached identity when an account is reassigned to another app", async () => {
    const requestFn = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        bot: { app_name: "OldBot", open_id: "ou_old" },
      })
      .mockResolvedValueOnce({
        code: 0,
        bot: { app_name: "NewBot", open_id: "ou_new" },
      });
    createFeishuClientMock.mockReturnValue({ request: requestFn });

    await expect(
      probeFeishu({ accountId: "acct-switch", appId: "cli_old", appSecret: "secret_old" }), // pragma: allowlist secret
    ).resolves.toMatchObject({ ok: true, appId: "cli_old", botOpenId: "ou_old" });
    await expect(
      probeFeishu({ accountId: "acct-switch", appId: "cli_new", appSecret: "secret_new" }), // pragma: allowlist secret
    ).resolves.toMatchObject({ ok: true, appId: "cli_new", botOpenId: "ou_new" });
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("handles standard bot info nested under data", async () => {
    setupClient({
      code: 0,
      data: { bot: { app_name: "DataBot", open_id: "ou_data" } },
    });

    await expectDefaultSuccessResult(DEFAULT_CREDS, {
      ...DEFAULT_SUCCESS_RESULT,
      botName: "DataBot",
      botOpenId: "ou_data",
    });
  });

  it("registers the app as an AI agent through a separate best-effort request", async () => {
    const requestFn = setupClient({ code: 0 });

    await expect(registerFeishuAiAgent(DEFAULT_CREDS)).resolves.toEqual({ ok: true });
    expect(requestFn).toHaveBeenCalledWith({
      method: "POST",
      url: "/open-apis/bot/v1/openclaw_bot/ping",
      data: { needBotInfo: true },
      timeout: FEISHU_PROBE_REQUEST_TIMEOUT_MS,
    });
  });

  it("contains AI-agent registration API failures", async () => {
    setupClient({ code: 99991403, msg: "quota exhausted" });

    await expect(registerFeishuAiAgent(DEFAULT_CREDS)).resolves.toEqual({
      ok: false,
      reason: "api-error",
    });
  });

  it("contains AI-agent registration request failures", async () => {
    createFeishuClientMock.mockReturnValue({
      request: vi.fn().mockRejectedValue(new Error("network error")),
    });

    await expect(registerFeishuAiAgent(DEFAULT_CREDS)).resolves.toEqual({
      ok: false,
      reason: "request-error",
    });
  });

  it("bounds AI-agent registration timeouts", async () => {
    await withFakeTimers(async () => {
      createFeishuClientMock.mockReturnValue({
        request: vi.fn().mockImplementation(() => new Promise(() => {})),
      });

      const promise = registerFeishuAiAgent(DEFAULT_CREDS, { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(promise).resolves.toEqual({ ok: false, reason: "timeout" });
    });
  });

  it("does not start AI-agent registration after abort", async () => {
    createFeishuClientMock.mockClear();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      registerFeishuAiAgent(DEFAULT_CREDS, { abortSignal: abortController.signal }),
    ).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });
});
