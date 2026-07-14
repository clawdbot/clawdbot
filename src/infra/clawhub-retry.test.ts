import { describe, expect, it, vi } from "vitest";
import { retryClawHubRead } from "./clawhub-retry.js";

describe("retryClawHubRead", () => {
  it("honors Retry-After and cancels the discarded response", async () => {
    const cancel = vi.fn();
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryClawHubRead(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            response: new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancel();
                },
              }),
              {
                status: 503,
                headers: { "Retry-After": "1" },
              },
            ),
          };
        }
        return { response: new Response("ok") };
      },
      {
        disposeRetry: async ({ response }) => {
          await response.body?.cancel();
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(await result.response.text()).toBe("ok");
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["0.5", "1.5"])(
    "ignores fractional Retry-After delay-seconds values: %s",
    async (retryAfter) => {
      const delays: number[] = [];
      let attempts = 0;

      const result = await retryClawHubRead(
        async () => {
          attempts += 1;
          return {
            response: new Response(attempts === 1 ? "limited" : "ok", {
              status: attempts === 1 ? 503 : 200,
              headers: attempts === 1 ? { "Retry-After": retryAfter } : undefined,
            }),
          };
        },
        {
          disposeRetry: async ({ response }) => {
            await response.body?.cancel();
          },
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      );

      expect(await result.response.text()).toBe("ok");
      expect(delays).toEqual([1_000]);
    },
  );

  it("ignores Retry-After HTTP dates that Date.parse would normalize", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-03-02T23:59:30.000Z"));
    try {
      const delays: number[] = [];
      let attempts = 0;

      const result = await retryClawHubRead(
        async () => {
          attempts += 1;
          return {
            response: new Response(attempts === 1 ? "limited" : "ok", {
              status: attempts === 1 ? 503 : 200,
              headers:
                attempts === 1 ? { "Retry-After": "Sun, 31 Feb 2027 00:00:00 GMT" } : undefined,
            }),
          };
        },
        {
          disposeRetry: async ({ response }) => {
            await response.body?.cancel();
          },
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      );

      expect(await result.response.text()).toBe("ok");
      expect(delays).toEqual([1_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transport failures with the bounded schedule", async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await retryClawHubRead(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new TypeError("fetch failed");
        }
        return { response: new Response("ok") };
      },
      {
        disposeRetry: async () => {},
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(await result.response.text()).toBe("ok");
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
  });

  it("does not retry 429 unless the caller enables rate-limit retries", async () => {
    let defaultAttempts = 0;
    const defaultResult = await retryClawHubRead(
      async () => {
        defaultAttempts += 1;
        return { response: new Response("limited", { status: 429 }) };
      },
      {
        disposeRetry: async () => {},
        sleep: async () => {},
      },
    );

    let optedInAttempts = 0;
    const optedInResult = await retryClawHubRead(
      async () => {
        optedInAttempts += 1;
        return {
          response: new Response(optedInAttempts === 1 ? "limited" : "ok", {
            status: optedInAttempts === 1 ? 429 : 200,
          }),
        };
      },
      {
        disposeRetry: async ({ response }) => {
          await response.body?.cancel();
        },
        retryRateLimit: true,
        sleep: async () => {},
      },
    );

    expect(defaultResult.response.status).toBe(429);
    expect(defaultAttempts).toBe(1);
    expect(await optedInResult.response.text()).toBe("ok");
    expect(optedInAttempts).toBe(2);
  });

  it("returns the final retryable response for caller-owned HTTP handling", async () => {
    const disposeRetry = vi.fn(async ({ response }: { response: Response }) => {
      await response.body?.cancel();
    });
    const result = await retryClawHubRead(
      async () => ({ response: new Response("unavailable", { status: 503 }) }),
      { disposeRetry, sleep: async () => {} },
    );

    expect(result.response.status).toBe(503);
    expect(disposeRetry).toHaveBeenCalledTimes(3);
  });
});
