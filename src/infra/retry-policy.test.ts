// Covers channel API retry policy behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfterHeaderSeconds } from "./retry-after.js";
import { createChannelApiRetryRunner } from "./retry-policy.js";

const ZERO_DELAY_RETRY = { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

async function runRetryCase(params: {
  runnerOptions: Parameters<typeof createChannelApiRetryRunner>[0];
  fnSteps: Array<{ type: "reject" | "resolve"; value: unknown }>;
  expectedCalls: number;
  expectedValue?: unknown;
  expectedError?: string;
}): Promise<void> {
  vi.useFakeTimers();
  const runner = createChannelApiRetryRunner(params.runnerOptions);
  const fn = vi.fn();
  const allRejects =
    params.fnSteps.length > 0 && params.fnSteps.every((step) => step.type === "reject");
  if (allRejects) {
    fn.mockRejectedValue(params.fnSteps[0]?.value);
  }
  for (const [index, step] of params.fnSteps.entries()) {
    if (allRejects && index > 0) {
      break;
    }
    if (step.type === "reject") {
      fn.mockRejectedValueOnce(step.value);
    } else {
      fn.mockResolvedValueOnce(step.value);
    }
  }

  const promise = runner(fn, "test");
  const assertion = params.expectedError
    ? expect(promise).rejects.toThrow(params.expectedError)
    : expect(promise).resolves.toBe(params.expectedValue);

  await vi.runAllTimersAsync();
  await assertion;
  expect(fn).toHaveBeenCalledTimes(params.expectedCalls);
}

describe("createChannelApiRetryRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("strictShouldRetry", () => {
    it.each([
      {
        name: "falls back to regex matching when strictShouldRetry is disabled",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
          shouldRetry: () => false,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("read ECONNRESET"), {
              code: "ECONNRESET",
            }),
          },
        ],
        expectedCalls: 2,
        expectedError: "ECONNRESET",
      },
      {
        name: "suppresses regex fallback when strictShouldRetry is enabled",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
          shouldRetry: () => false,
          strictShouldRetry: true,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("read ECONNRESET"), {
              code: "ECONNRESET",
            }),
          },
        ],
        expectedCalls: 1,
        expectedError: "ECONNRESET",
      },
      {
        name: "still retries when the strict predicate returns true",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
          shouldRetry: (err: unknown) => (err as { code?: string }).code === "ECONNREFUSED",
          strictShouldRetry: true,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("ECONNREFUSED"), {
              code: "ECONNREFUSED",
            }),
          },
          { type: "resolve" as const, value: "ok" },
        ],
        expectedCalls: 2,
        expectedValue: "ok",
      },
      {
        name: "does not retry unrelated errors when neither predicate nor regex match",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("permission denied"), {
              code: "EACCES",
            }),
          },
        ],
        expectedCalls: 1,
        expectedError: "permission denied",
      },
      {
        name: "retries grammY HttpError wrapping network error via .cause traversal",
        runnerOptions: {
          retry: { ...ZERO_DELAY_RETRY, attempts: 2 },
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("Network request for 'sendMessage' failed!"), {
              cause: new Error("ECONNRESET"),
            }),
          },
        ],
        expectedCalls: 2,
        expectedError: "Network request",
      },
      {
        name: "keeps retrying retriable errors until attempts are exhausted",
        runnerOptions: {
          retry: ZERO_DELAY_RETRY,
        },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("connection timeout"), {
              code: "ETIMEDOUT",
            }),
          },
        ],
        expectedCalls: 3,
        expectedError: "connection timeout",
      },
    ])("$name", async ({ runnerOptions, fnSteps, expectedCalls, expectedValue, expectedError }) => {
      await runRetryCase({
        runnerOptions,
        fnSteps,
        expectedCalls,
        expectedValue,
        expectedError,
      });
    });
  });

  describe("default retry behavior", () => {
    it("retries misdirected request errors from Telegram edge nodes", async () => {
      await runRetryCase({
        runnerOptions: { retry: ZERO_DELAY_RETRY },
        fnSteps: [
          {
            type: "reject" as const,
            value: Object.assign(new Error("421 Misdirected Request"), {
              status: 421,
            }),
          },
        ],
        expectedCalls: 3,
        expectedError: "421 Misdirected Request",
      });
    });
  });

  it("honors nested retry_after hints before retrying", async () => {
    vi.useFakeTimers();

    const runner = createChannelApiRetryRunner({
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1_000, jitter: 0 },
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 1 } },
      })
      .mockResolvedValue("ok");

    const promise = runner(fn, "test");

    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses an injected retry-after reader instead of the Telegram body default", async () => {
    vi.useFakeTimers();

    const retryAfterMs = vi.fn(() => 250);
    const runner = createChannelApiRetryRunner({
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1_000, jitter: 0 },
      retryAfterMs,
    });
    const error = {
      message: "429 Too Many Requests",
      parameters: { retry_after: 1 },
    };
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok");

    const promise = runner(fn, "test");

    await vi.advanceTimersByTimeAsync(249);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(retryAfterMs).toHaveBeenCalledWith(error);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps retry_after hints capped by maxDelayMs by default", async () => {
    vi.useFakeTimers();

    const runner = createChannelApiRetryRunner({
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 30_000, jitter: 0 },
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 45 } },
      })
      .mockResolvedValue("ok");

    const promise = runner(fn, "test");

    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors retry_after above maxDelayMs when a separate retry-after cap is configured", async () => {
    vi.useFakeTimers();

    const runner = createChannelApiRetryRunner({
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 30_000, jitter: 0 },
      retryAfterMaxDelayMs: 60_000,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 45 } },
      })
      .mockResolvedValue("ok");

    const promise = runner(fn, "test");

    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("parseRetryAfterHeaderSeconds", () => {
  it.each([
    ["delay seconds", " 15 ", Date.UTC(2026, 4, 1, 12, 0, 0), 15],
    ["HTTP date", "Fri, 01 May 2026 12:00:05 GMT", Date.UTC(2026, 4, 1, 12, 0, 0), 5],
    ["RFC 850 date", "Friday, 01-May-26 12:00:05 GMT", Date.UTC(2026, 4, 1, 12, 0, 0), 5],
    ["asctime date", "Fri May  1 12:00:05 2026", Date.UTC(2026, 4, 1, 12, 0, 0), 5],
    ["past HTTP date", "Fri, 01 May 2026 11:59:55 GMT", Date.UTC(2026, 4, 1, 12, 0, 0), 0],
  ])("parses $name", (_name, value, now, expected) => {
    expect(parseRetryAfterHeaderSeconds(value, now)).toBe(expected);
  });

  it.each([
    null,
    "",
    "1.5",
    "+1",
    "1 second",
    "9007199254741",
    "Sun Nov 99 99:99:99 9999",
    "Friday, 01 May 2026 12:00:05 GMT",
  ])("rejects invalid value %j", (value) => {
    expect(parseRetryAfterHeaderSeconds(value)).toBeUndefined();
  });
});
