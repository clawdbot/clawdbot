// Thread binding lifecycle tests cover binding states across channel threads.
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingExpiry,
  resolveThreadBindingLifecycle,
} from "./thread-binding-lifecycle.js";

describe("resolveThreadBindingLifecycle", () => {
  it.each([
    {
      boundAt: 100,
      lastActivityAt: 50,
      idleTimeoutMs: 10,
      maxAgeMs: 10,
      expected: { expiresAt: 110, reason: "idle-expired" },
    },
    {
      boundAt: -100,
      lastActivityAt: -50,
      idleTimeoutMs: 10.9,
      maxAgeMs: 0,
      expected: { expiresAt: -40, reason: "idle-expired" },
    },
    { boundAt: 0, lastActivityAt: 0, idleTimeoutMs: 0, maxAgeMs: 0, expected: {} },
    {
      boundAt: 100,
      lastActivityAt: 100,
      idleTimeoutMs: Number.NaN,
      maxAgeMs: 10,
      expected: { expiresAt: 110, reason: "max-age-expired" },
    },
    {
      boundAt: 100,
      lastActivityAt: 100,
      idleTimeoutMs: Infinity,
      maxAgeMs: 0,
      expected: { expiresAt: Infinity, reason: "idle-expired" },
    },
  ])("preserves stored lifecycle semantics for %j", ({ expected, ...record }) => {
    expect(
      resolveThreadBindingLifecycle({ record, defaultIdleTimeoutMs: 500, defaultMaxAgeMs: 500 }),
    ).toEqual(expected);
  });

  it("selects caller-prepared deadlines without normalizing legacy activity", () => {
    expect(resolveThreadBindingExpiry({ inactivityExpiresAt: 60, maxAgeExpiresAt: 110 })).toEqual({
      expiresAt: 60,
      reason: "idle-expired",
    });
    expect(resolveThreadBindingExpiry({ inactivityExpiresAt: 110, maxAgeExpiresAt: 110 })).toEqual({
      expiresAt: 110,
      reason: "idle-expired",
    });
    expect(resolveThreadBindingExpiry({ maxAgeExpiresAt: 110 })).toEqual({
      expiresAt: 110,
      reason: "max-age-expired",
    });
  });

  it("prefers the earliest idle or max-age expiration", () => {
    expect(
      resolveThreadBindingLifecycle({
        record: {
          boundAt: 100,
          lastActivityAt: 300,
          idleTimeoutMs: 50,
          maxAgeMs: 1_000,
        },
        defaultIdleTimeoutMs: 24 * 60 * 60 * 1000,
        defaultMaxAgeMs: 0,
      }),
    ).toEqual({ expiresAt: 350, reason: "idle-expired" });

    expect(
      resolveThreadBindingLifecycle({
        record: {
          boundAt: 100,
          lastActivityAt: 300,
          idleTimeoutMs: 1_000,
          maxAgeMs: 150,
        },
        defaultIdleTimeoutMs: 24 * 60 * 60 * 1000,
        defaultMaxAgeMs: 0,
      }),
    ).toEqual({ expiresAt: 250, reason: "max-age-expired" });
  });

  it("uses defaults when record-level timeouts are absent", () => {
    expect(
      resolveThreadBindingLifecycle({
        record: { boundAt: 100, lastActivityAt: 300 },
        defaultIdleTimeoutMs: 200,
        defaultMaxAgeMs: 0,
      }),
    ).toEqual({ expiresAt: 500, reason: "idle-expired" });
  });
});
