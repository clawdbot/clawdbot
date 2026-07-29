/**
 * Concurrent Feishu message send stress tests.
 *
 * Verifies that sendMessageFeishu behaves correctly under concurrent load,
 * including the rate-limit error code (230020) the Feishu API returns when
 * the per-chat request frequency is too high. Related: issue #70879.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const {
  mockClientCreate,
  mockCreateFeishuClient,
  mockResolveFeishuAccount,
  mockConvertMarkdownTables,
  mockResolveMarkdownTableMode,
} = vi.hoisted(() => ({
  mockClientCreate: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
  mockConvertMarkdownTables: vi.fn((text: string) => text),
  mockResolveMarkdownTableMode: vi.fn(() => "preserve"),
}));

vi.mock("./client.js", () => ({ createFeishuClient: mockCreateFeishuClient }));
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
  resolveFeishuRuntimeAccount: mockResolveFeishuAccount,
}));
vi.mock("openclaw/plugin-sdk/markdown-table-runtime", () => ({
  resolveMarkdownTableMode: mockResolveMarkdownTableMode,
}));
vi.mock("openclaw/plugin-sdk/text-chunking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/text-chunking")>();
  return { ...actual, convertMarkdownTables: mockConvertMarkdownTables };
});
vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: vi.fn(() => "preserve"),
        convertMarkdownTables: vi.fn((text: string) => text),
      },
    },
  }),
}));

let sendMessageFeishu: typeof import("./send.js").sendMessageFeishu;

const MOCK_CFG = {} as ClawdbotConfig;

/** Build a successful send response. */
function okResponse(messageId: string) {
  return { code: 0, data: { message_id: messageId } };
}

/**
 * Build an AxiosError-shaped object for a Feishu rate-limit HTTP 400 response.
 * Mirrors what @larksuiteoapi/node-sdk throws when the server returns code 230020.
 */
function axiosRateLimitError(code = 230020) {
  return Object.assign(new Error("Request failed with status code 400"), {
    response: {
      status: 400,
      data: {
        code,
        msg: "This operation triggers the frequency limit, ext=chat rate limit",
      },
    },
  });
}

beforeAll(async () => {
  ({ sendMessageFeishu } = await import("./send.js"));
});

afterAll(() => {
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveFeishuAccount.mockReturnValue({ accountId: "default", configured: true });
  mockResolveMarkdownTableMode.mockReturnValue("preserve");
  mockConvertMarkdownTables.mockImplementation((text: string) => text);
  mockCreateFeishuClient.mockReturnValue({
    im: { message: { create: mockClientCreate } },
  });
});

describe("Concurrent Feishu sends — happy path", () => {
  it("all concurrent sends succeed when API responds without errors", async () => {
    const CONCURRENCY = 10;
    let n = 0;
    mockClientCreate.mockImplementation(() => Promise.resolve(okResponse(`om_happy_${n++}`)));

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        sendMessageFeishu({ cfg: MOCK_CFG, to: `oc_chat_${i}`, text: `Message ${i}` }),
      ),
    );

    expect(results).toHaveLength(CONCURRENCY);
    for (const result of results) {
      expect(result.messageId).toBeTruthy();
      expect(result.receipt).toBeDefined();
    }
    expect(mockClientCreate).toHaveBeenCalledTimes(CONCURRENCY);
  });

  it("sends 20 messages concurrently and all resolve independently", async () => {
    const CONCURRENCY = 20;
    let n = 0;
    mockClientCreate.mockImplementation(() => Promise.resolve(okResponse(`om_concurrent_${n++}`)));

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        sendMessageFeishu({ cfg: MOCK_CFG, to: "oc_stress", text: `stress-${i}` }),
      ),
    );

    expect(results).toHaveLength(CONCURRENCY);
    expect(mockClientCreate).toHaveBeenCalledTimes(CONCURRENCY);

    // All message IDs should be unique
    const messageIds = results.map((r) => r.messageId);
    expect(new Set(messageIds).size).toBe(CONCURRENCY);
  });
});

describe("Concurrent Feishu sends — rate-limit behavior (code 230020)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws on rate-limit code 230020 after exhausting retries", async () => {
    vi.useFakeTimers();
    mockClientCreate.mockRejectedValue(axiosRateLimitError(230020));

    // Promise.allSettled attaches a rejection handler synchronously, so when
    // vi.runAllTimersAsync advances timers and fires the rejection, it is
    // already handled. Using expect().rejects.toThrow() would defer the
    // attachment via Promise.resolve().then(), causing an unhandled-rejection
    // warning before the handler is registered.
    const settled = Promise.allSettled([
      sendMessageFeishu({ cfg: MOCK_CFG, to: "oc_rl", text: "rate limited" }),
    ]);
    await vi.runAllTimersAsync();
    const [result] = await settled;

    expect(result.status).toBe("rejected");
    // 1 initial attempt + 2 retries = 3 total calls
    expect(mockClientCreate).toHaveBeenCalledTimes(3);
  });

  it("some concurrent sends fail with rate-limit while others succeed", async () => {
    vi.useFakeTimers();
    const HALF = 4;
    let n = 0;

    // Distinguish sends by receive_id: targets containing "fail" always rate-limit.
    mockClientCreate.mockImplementation((params: { data?: { receive_id?: string } }) => {
      const target = params?.data?.receive_id ?? "";
      if (target.includes("fail")) {
        return Promise.reject(axiosRateLimitError());
      }
      return Promise.resolve(okResponse(`om_ok_${n++}`));
    });

    const settled = Promise.allSettled([
      ...Array.from({ length: HALF }, (_, i) =>
        sendMessageFeishu({ cfg: MOCK_CFG, to: `oc_fail_${i}`, text: `fail-${i}` }),
      ),
      ...Array.from({ length: HALF }, (_, i) =>
        sendMessageFeishu({ cfg: MOCK_CFG, to: `oc_ok_${i}`, text: `ok-${i}` }),
      ),
    ]);

    await vi.runAllTimersAsync();
    const results = await settled;

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(HALF);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(HALF);
    // Rate-limited sends: HALF × 3 calls (1 + 2 retries); successful sends: HALF × 1 call
    expect(mockClientCreate).toHaveBeenCalledTimes(HALF * 3 + HALF);
  });

  it("all concurrent sends fail gracefully when API consistently rate-limits", async () => {
    vi.useFakeTimers();
    const CONCURRENCY = 5;
    mockClientCreate.mockRejectedValue(axiosRateLimitError(230020));

    const settled = Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        sendMessageFeishu({ cfg: MOCK_CFG, to: "oc_all_fail", text: `msg-${i}` }),
      ),
    );

    await vi.runAllTimersAsync();
    const results = await settled;

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    // Each send retries twice: CONCURRENCY × 3 total calls
    expect(mockClientCreate).toHaveBeenCalledTimes(CONCURRENCY * 3);
  });

  it("recovers when API rate-limits once then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    mockClientCreate
      .mockRejectedValueOnce(axiosRateLimitError(230020))
      .mockImplementation(() => Promise.resolve(okResponse(`om_recovered_${n++}`)));

    const sendPromise = sendMessageFeishu({ cfg: MOCK_CFG, to: "oc_recover", text: "recover" });
    await vi.runAllTimersAsync();

    const result = await sendPromise;
    expect(result.messageId).toMatch(/^om_recovered_/);
    // 1 rate-limited call + 1 successful retry
    expect(mockClientCreate).toHaveBeenCalledTimes(2);
  });

  it("rate-limit error message surfaces feishu_code for caller detection", async () => {
    vi.useFakeTimers();
    mockClientCreate.mockRejectedValue(axiosRateLimitError(230020));

    // Same pattern: allSettled attaches the handler synchronously before timers advance.
    const settled = Promise.allSettled([
      sendMessageFeishu({
        cfg: MOCK_CFG,
        to: "oc_err_msg",
        text: "check error message",
      }),
    ]);
    await vi.runAllTimersAsync();
    const [result] = await settled;

    expect(result.status).toBe("rejected");
    const error = result.status === "rejected" ? result.reason : null;
    expect(error).toBeInstanceOf(Error);
    // Error message must carry feishu_code so retry/circuit-breaker logic upstream can identify it
    expect((error as Error).message).toMatch(/230020/);
  });
});

describe("Concurrent Feishu sends — timing and ordering", () => {
  it("concurrent sends complete faster than sequential would (all fire in parallel)", async () => {
    const CONCURRENCY = 5;
    const SIMULATED_DELAY_MS = 20;
    let n = 0;

    mockClientCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(okResponse(`om_timed_${n++}`)), SIMULATED_DELAY_MS);
        }),
    );

    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        sendMessageFeishu({ cfg: MOCK_CFG, to: `oc_timed_${i}`, text: `msg ${i}` }),
      ),
    );
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(CONCURRENCY);
    // Concurrent: should complete in roughly 1x delay, not CONCURRENCY * delay
    expect(elapsed).toBeLessThan(SIMULATED_DELAY_MS * CONCURRENCY);
  });

  it("sends to multiple distinct targets resolve independently", async () => {
    const targets = ["oc_alpha", "oc_beta", "oc_gamma"];
    let n = 0;
    mockClientCreate.mockImplementation(() => Promise.resolve(okResponse(`om_target_${n++}`)));

    const results = await Promise.all(
      targets.map((to) => sendMessageFeishu({ cfg: MOCK_CFG, to, text: "hello" })),
    );

    expect(results).toHaveLength(targets.length);
    for (const result of results) {
      expect(result.messageId).toBeTruthy();
    }
    expect(mockClientCreate).toHaveBeenCalledTimes(targets.length);
  });
});
