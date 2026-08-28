/**
 * Tests Daytona control-plane retry classification through withDaytonaRetry.
 */
import { describe, expect, it } from "vitest";
import { withDaytonaRetry } from "./client.js";

async function runWithFirstFailure(error: () => unknown): Promise<{
  result?: string;
  attempts: number;
  failure?: unknown;
}> {
  let attempts = 0;
  try {
    const result = await withDaytonaRetry("test", async () => {
      attempts += 1;
      if (attempts === 1) {
        throw error();
      }
      return "ok";
    });
    return { result, attempts };
  } catch (failure) {
    return { attempts, failure };
  }
}

describe("withDaytonaRetry", () => {
  it("retries an undici fetch failure whose code lives on error.cause", async () => {
    const run = await runWithFirstFailure(() =>
      Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }),
    );
    expect(run.failure).toBeUndefined();
    expect(run.result).toBe("ok");
    expect(run.attempts).toBe(2);
  });

  it.each(["ECONNREFUSED", "EPIPE", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"])(
    "retries a transient %s control-plane failure",
    async (code) => {
      const run = await runWithFirstFailure(() =>
        Object.assign(new Error("connect fail"), { code }),
      );
      expect(run.failure).toBeUndefined();
      expect(run.result).toBe("ok");
      expect(run.attempts).toBe(2);
    },
  );

  it.each([502, 503, 504])("retries a %s status response", async (statusCode) => {
    const run = await runWithFirstFailure(() =>
      Object.assign(new Error("bad gateway"), { statusCode }),
    );
    expect(run.failure).toBeUndefined();
    expect(run.result).toBe("ok");
    expect(run.attempts).toBe(2);
  });

  it("does not retry a permanent API error", async () => {
    const run = await runWithFirstFailure(() =>
      Object.assign(new Error("invalid request"), { statusCode: 400 }),
    );
    expect(run.result).toBeUndefined();
    expect(run.attempts).toBe(1);
    expect(run.failure).toMatchObject({ statusCode: 400 });
  });
});
