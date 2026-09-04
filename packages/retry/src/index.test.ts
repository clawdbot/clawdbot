import { describe, expect, it, vi } from "vitest";
import {
  computeBackoff,
  computeBackoffSchedule,
  createRetryRunner,
  RetrySupervisor,
  retryAsync,
  sleepWithAbort,
  toRetryError,
} from "./index.js";

describe("RetrySupervisor", () => {
  it("owns attempt counting, overrides, rebasing, and exhaustion", () => {
    const supervisor = new RetrySupervisor({ initialMs: 100, maxMs: 250, factor: 2, jitter: 0 }, 2);

    const first = supervisor.next();
    expect(first).toMatchObject({ attempt: 1, delayMs: 100 });

    supervisor.nextDelayOverrideMs = 175;
    const override = supervisor.next();
    expect(override).toMatchObject({ attempt: 1, delayMs: 175 });

    const second = supervisor.next();
    expect(second).toMatchObject({ attempt: 2, delayMs: 200 });
    expect(supervisor.next()).toBeUndefined();
    expect(supervisor.attempts).toBe(3);

    supervisor.reset(25);
    expect(supervisor.next()).toMatchObject({ attempt: 1, delayMs: 25 });
  });

  it("uses exact capped schedules", () => {
    expect(
      [0, 1, 2, 3, 4, 5].map((attempt) => computeBackoffSchedule([5, 25, 120], attempt)),
    ).toEqual([0, 5, 25, 120, 120, 120]);
  });

  it("keeps long-lived exponential backoff at its cap", () => {
    expect(computeBackoff({ initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0 }, 1_016)).toBe(
      30_000,
    );
  });

  it("cancels a pending wait with the canonical abort error", async () => {
    vi.useFakeTimers();
    try {
      const supervisor = new RetrySupervisor({
        initialMs: 100,
        maxMs: 100,
        factor: 2,
        jitter: 0,
      });
      const retry = supervisor.next();
      const wait = sleepWithAbort(retry?.delayMs ?? 0, retry?.signal);
      const reason = new Error("stop");
      supervisor.cancel(reason);

      await expect(wait).rejects.toMatchObject({
        name: "AbortError",
        message: "aborted",
        cause: reason,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can unref the scheduled timer", async () => {
    const controller = new AbortController();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const sleeper = sleepWithAbort(60_000, controller.signal, { ref: false });
      const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout | undefined;

      expect(timer?.hasRef()).toBe(false);
      controller.abort();
      await expect(sleeper).rejects.toMatchObject({ name: "AbortError", message: "aborted" });
    } finally {
      controller.abort();
      setTimeoutSpy.mockRestore();
    }
  });
});

describe("retryAsync", () => {
  it.each([
    ["fractional floor without jitter", 1.4, 0, 10, 0, 2],
    ["fractional floor with jitter", 1.4, 0, 10, 0.5, 2],
    ["server hint below the cap", 1_000, 1, 60_000, 0.5, 1_000],
    ["server hint at the cap", 1_000, 1, 1_000, 0.5, 1_000],
    ["symmetric jitter above the cap", 10_000, 1, 1_000, 0.5, 500],
  ] as const)(
    "respects Retry-After: %s",
    async (_name, retryAfterMs, minDelayMs, maxDelayMs, jitter, expectedDelay) => {
      const sleeps: number[] = [];
      const run = createRetryRunner({ sleep: async (ms) => void sleeps.push(ms) });
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockResolvedValueOnce("ok");

      await expect(
        run(operation, {
          attempts: 2,
          minDelayMs,
          maxDelayMs,
          jitter,
          random: () => 0,
          retryAfterMs: () => retryAfterMs,
        }),
      ).resolves.toBe("ok");
      expect(sleeps).toEqual([expectedDelay]);
    },
  );

  it("supports custom schedules, abortable sleeps, and async retry hooks", async () => {
    const events: string[] = [];
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce("ok");

    await expect(
      retryAsync(operation, {
        attempts: 3,
        minDelayMs: 0,
        maxDelayMs: 100,
        delayMs: ({ attempt }) => [10, 30][attempt - 1] ?? 0,
        onRetry: async ({ attempt }) => void events.push(`retry:${attempt}`),
        sleep: async (ms) => void events.push(`sleep:${ms}`),
      }),
    ).resolves.toBe("ok");
    expect(events).toEqual(["retry:1", "sleep:10", "retry:2", "sleep:30"]);
  });

  it("preserves terminal Error identity", async () => {
    const terminal = new Error("terminal");
    await expect(
      retryAsync(
        async () => {
          throw terminal;
        },
        {
          attempts: 1,
        },
      ),
    ).rejects.toBe(terminal);
  });

  it("clamps numeric overload delays to the Node timer ceiling", async () => {
    const sleeps: number[] = [];
    const run = createRetryRunner({ sleep: async (ms) => void sleeps.push(ms) });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce("ok");

    await run(operation, 2, Number.POSITIVE_INFINITY);
    expect(sleeps).toEqual([2_147_000_000]);
  });
});

describe("toRetryError", () => {
  // JSON.parse produces a real own enumerable "__proto__" property; an object
  // literal { __proto__: x } does not, so the literal form does not reproduce
  // the prototype-hijack defect that Object.assign's [[Set]] triggers.
  const protoPayload = () =>
    JSON.parse('{"__proto__":{"tag":"X"},"code":"E_UPSTREAM","status":503}');

  it("returns a value that satisfies its declared Error return type", () => {
    expect(toRetryError(protoPayload(), "Non-Error thrown")).toBeInstanceOf(Error);
  });

  it("keeps Error.prototype against a __proto__-carrying payload", () => {
    expect(Object.getPrototypeOf(toRetryError(protoPayload()))).toBe(Error.prototype);
  });

  it("propagates a throwing enumerable __proto__ getter like Object.assign", () => {
    // Object.assign reads each source value before its target write, so the
    // skipped __proto__ key's own accessor must still run (and may throw);
    // only the target assignment is discarded.
    const hostile: Record<string, unknown> = { code: "EIO" };
    Object.defineProperty(hostile, "__proto__", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("getter trap");
      },
    });

    expect(() => toRetryError(hostile)).toThrow("getter trap");
  });

  it("still copies the ordinary diagnostic fields", () => {
    const e = toRetryError(protoPayload()) as Error & { code?: string; status?: number };
    expect([e.code, e.status]).toEqual(["E_UPSTREAM", 503]);
  });

  it("does not pollute Object.prototype", () => {
    protoPayload();
    toRetryError(protoPayload());
    expect(({} as { tag?: unknown }).tag).toBeUndefined();
  });

  it("propagates a descriptor trap observed through the skipped __proto__ key", () => {
    // Object.assign reads every source descriptor before its target write, so
    // the skipped __proto__ key must still observe its descriptor trap rather
    // than being exempted before the read.
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => ["__proto__", "code"],
        getOwnPropertyDescriptor: (_target, key) => {
          if (key === "__proto__") {
            throw new Error("descriptor trap");
          }
          return { enumerable: true, configurable: true };
        },
        get: (target, key, receiver) =>
          key === "code" ? "EIO" : Reflect.get(target, key, receiver),
      },
    );

    expect(() => toRetryError(hostile)).toThrow("descriptor trap");
  });

  it("preserves harmless constructor/prototype diagnostic fields", () => {
    const payload = () =>
      JSON.parse(
        '{"__proto__":{"tag":"X"},"constructor":"Sentinel","prototype":"Proto","code":"E_UPSTREAM"}',
      );
    const error = toRetryError(payload()) as Error & { code?: string };

    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(Reflect.get(error, "constructor")).toBe("Sentinel");
    expect(Reflect.get(error, "prototype")).toBe("Proto");
    expect(error.code).toBe("E_UPSTREAM");
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
  });

  it("preserves non-enumerable Error field descriptors copied from source", () => {
    const payload = () =>
      JSON.parse(
        '{"__proto__":{"tag":"X"},"message":"remote","cause":"c","stack":"s","code":"E_UPSTREAM"}',
      );
    const error = toRetryError(payload()) as Error & { code?: string };

    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error.message).toBe("remote");
    expect(error.cause).toBe("c");
    expect(error.stack).toBe("s");
    expect(error.code).toBe("E_UPSTREAM");
    expect(Object.prototype.propertyIsEnumerable.call(error, "message")).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(error, "cause")).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(error, "stack")).toBe(false);
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
  });

  it("propagates throwing source accessors instead of swallowing them", () => {
    const throwingGetter = {
      get details(): never {
        throw new Error("unexpected structured field read");
      },
      code: "EIO",
    };

    expect(() => toRetryError(throwingGetter, "fallback")).toThrow(
      "unexpected structured field read",
    );
  });

  it("propagates failed target assignments like Object.assign, not Reflect.set", () => {
    // A non-writable inherited Error field (hardened prototype / frozen subclass)
    // makes Object.assign throw on [[Set]]; the copy must preserve that throwing
    // path instead of silently dropping the field the way Reflect.set does (it
    // returns false). Mirrors toErrorObject; retry inlines the same loop.
    // Probe the hardened-prototype contract (CS [P2]): a non-writable inherited
    // Error field must make [[Set]] throw under Object.assign semantics.
    // eslint-disable-next-line no-extend-native -- intentional contract probe; restored in finally.
    Object.defineProperty(Error.prototype, "sealed", {
      value: "inherited",
      writable: false,
      configurable: true,
      enumerable: true,
    });
    const source = { sealed: "override", code: "E_UPSTREAM" };
    try {
      // paired contract: Object.assign throws on the same non-writable field
      expect(() => Object.assign(new Error("fallback"), source)).toThrow(TypeError);
      // the coercer must throw too, preserving Object.assign semantics
      expect(() => toRetryError(source, "fallback")).toThrow(TypeError);
    } finally {
      Reflect.deleteProperty(Error.prototype, "sealed");
    }
  });

  it("preserves enumerable Symbol-keyed diagnostics", () => {
    // Object.assign copies own enumerable Symbol properties; Object.keys
    // excludes Symbols, so the prior loop silently dropped them.
    const detailKey = Symbol("detail");
    const value = { code: "EIO", [detailKey]: "symbol detail" };

    const error = toRetryError(value, "fallback") as Error & {
      code?: string;
    };

    expect(error.code).toBe("EIO");
    expect(Reflect.get(error, detailKey)).toBe("symbol detail");
    expect(Object.prototype.propertyIsEnumerable.call(error, detailKey)).toBe(true);
  });

  it("respects a getter that makes a later field non-enumerable", () => {
    // Object.assign calls [[GetOwnProperty]] per step, so an earlier enumerable
    // getter that flips a later field to non-enumerable skips it. Object.keys
    // snapshots before the getter runs, so the prior loop copied the now-stale
    // enumerable field.
    const value: { first: string; second: string } = {
      first: "first-value",
      second: "should-not-copy",
    };
    Object.defineProperty(value, "first", {
      enumerable: true,
      configurable: true,
      get: () => {
        Object.defineProperty(value, "second", {
          value: "should-not-copy",
          enumerable: false,
          configurable: true,
        });
        return "first-value";
      },
    });

    const error = toRetryError(value, "fallback") as Error & {
      first?: string;
      second?: string;
    };

    expect(error.first).toBe("first-value");
    expect(error).not.toHaveProperty("second");
  });
});
