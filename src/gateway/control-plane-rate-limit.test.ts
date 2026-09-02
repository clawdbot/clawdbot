// Covers control-plane write rate-limit windows, stale bucket pruning, and
// hard bucket cap behavior.
import { afterEach, describe, expect, test } from "vitest";
import {
  consumeControlPlaneWriteBudget,
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
  pruneStaleControlPlaneBuckets,
} from "./control-plane-rate-limit.js";

describe("control-plane-rate-limit", () => {
  const client = {
    connect: { device: { id: "dev-1" } },
    clientIp: "1.2.3.4",
  } as never;

  afterEach(() => {
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
  });

  test("pruneStaleControlPlaneBuckets removes expired buckets (#63643)", () => {
    // Create buckets at different times
    const baseMs = 1_000_000;
    consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-old" } }, clientIp: "1.2.3.4" } as never,
      method: "config.apply",
      nowMs: baseMs,
    });
    consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-recent" } }, clientIp: "5.6.7.8" } as never,
      method: "config.apply",
      nowMs: baseMs + 4 * 60_000,
    });

    // Prune at baseMs + 6 minutes — "dev-old" is > 5 min stale, "dev-recent" is only 2 min
    const pruned = pruneStaleControlPlaneBuckets(baseMs + 6 * 60_000);
    expect(pruned).toBe(1);

    // "dev-recent" should still have budget
    const result = consumeControlPlaneWriteBudget({
      client: { connect: { device: { id: "dev-recent" } }, clientIp: "5.6.7.8" } as never,
      method: "config.apply",
      nowMs: baseMs + 6 * 60_000,
    });
    expect(result.allowed).toBe(true);
  });

  test("pruneStaleControlPlaneBuckets is safe on empty map", () => {
    expect(pruneStaleControlPlaneBuckets()).toBe(0);
  });

  test("different methods from the same client use separate buckets", () => {
    for (let index = 0; index < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      expect(
        consumeControlPlaneWriteBudget({ client, method: "config.apply", nowMs: 1_000 }),
      ).toMatchObject({ allowed: true });
    }

    expect(
      consumeControlPlaneWriteBudget({ client, method: "plugins.setEnabled", nowMs: 1_000 }),
    ).toMatchObject({
      allowed: true,
      remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - 1,
    });
  });

  test("rejects the 31st call of the same method with the correct retry delay", () => {
    const baseMs = 10_000;
    for (let index = 0; index < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      consumeControlPlaneWriteBudget({ client, method: "config.patch", nowMs: baseMs });
    }

    expect(
      consumeControlPlaneWriteBudget({
        client,
        method: "config.patch",
        nowMs: baseMs + 10_000,
      }),
    ).toMatchObject({
      allowed: false,
      retryAfterMs: CONTROL_PLANE_RATE_LIMIT_WINDOW_MS - 10_000,
      remaining: 0,
    });
  });

  test("resets the method budget after the window", () => {
    const baseMs = 20_000;
    for (let index = 0; index < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      consumeControlPlaneWriteBudget({ client, method: "update.run", nowMs: baseMs });
    }

    expect(
      consumeControlPlaneWriteBudget({
        client,
        method: "update.run",
        nowMs: baseMs + CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
      }),
    ).toMatchObject({
      allowed: true,
      retryAfterMs: 0,
      remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - 1,
    });
  });

  test("control-plane bucket map evicts the oldest identity at its hard cap", () => {
    const baseMs = 2_000_000;
    const consume = (id: string) =>
      consumeControlPlaneWriteBudget({
        client: {
          connect: { device: { id } },
          clientIp: "1.2.3.4",
        } as never,
        method: "config.apply",
        nowMs: baseMs,
      });

    expect(consume("oldest").allowed).toBe(true);
    for (let index = 1; index < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; index += 1) {
      expect(consume("oldest").allowed).toBe(true);
    }
    expect(consume("oldest").allowed).toBe(false);

    for (let index = 0; index < 10_000; index += 1) {
      consume(`new-${index}`);
    }

    // A fresh budget proves the oldest bucket was evicted, without exposing
    // the internal map solely for tests.
    expect(consume("oldest")).toMatchObject({
      allowed: true,
      remaining: CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS - 1,
    });
  });
});
