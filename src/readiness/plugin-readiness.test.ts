import { describe, expect, it, vi } from "vitest";
import type { PluginReadinessCriterionRegistration } from "../plugins/registry-types.js";
import { createPluginReadinessResolver } from "./plugin-readiness.js";

function registration(
  check: PluginReadinessCriterionRegistration["criterion"]["check"],
): PluginReadinessCriterionRegistration {
  return {
    id: "plugin.storage.backend",
    pluginId: "storage",
    criterion: {
      id: "backend",
      description: "Reports storage backend availability.",
      check,
    },
    source: "/plugins/storage/index.js",
  };
}

describe("createPluginReadinessResolver", () => {
  it("evaluates registered criteria as advisory and coalesces cached calls", async () => {
    const check = vi.fn(() => ({
      status: "True" as const,
      reason: "StorageReady",
      message: "Storage is ready.",
    }));
    const criterion = registration(check);
    const resolve = createPluginReadinessResolver();
    const registry = { readinessCriteria: [criterion] };
    const config = {};

    const first = await resolve({ registry, config });
    const second = await resolve({ registry, config });

    expect(first).toEqual([
      expect.objectContaining({
        type: "plugin.storage.backend",
        status: "True",
        requirement: "advisory",
      }),
    ]);
    expect(second).toEqual(first);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("turns timeout and thrown errors into stable unknown evidence", async () => {
    const timeoutCriterion = registration(() => new Promise(() => {}));
    const resolveTimeout = createPluginReadinessResolver({ timeoutMs: 5, cacheTtlMs: 0 });
    const [timedOut] = await resolveTimeout({
      registry: { readinessCriteria: [timeoutCriterion] },
      config: {},
    });
    expect(timedOut).toMatchObject({ status: "Unknown", reason: "CriterionTimedOut" });

    const failedCriterion = registration(() => {
      throw new Error("backend offline");
    });
    const resolveFailure = createPluginReadinessResolver({ cacheTtlMs: 0 });
    const [failed] = await resolveFailure({
      registry: { readinessCriteria: [failedCriterion] },
      config: {},
    });
    expect(failed).toMatchObject({ status: "Unknown", reason: "CriterionCheckFailed" });
  });

  it("does not overlap a timed-out callback that ignores cancellation", async () => {
    let currentTime = 0;
    const check = vi.fn(() => new Promise<never>(() => {}));
    const criterion = registration(check);
    const registry = { readinessCriteria: [criterion] };
    const config = {};
    const resolve = createPluginReadinessResolver({
      timeoutMs: 5,
      cacheTtlMs: 10,
      now: () => currentTime,
    });

    const [first] = await resolve({ registry, config });
    currentTime = 20;
    const [afterCacheExpiry] = await resolve({
      registry,
      config,
    });

    expect(first).toMatchObject({ status: "Unknown", reason: "CriterionTimedOut" });
    expect(afterCacheExpiry).toEqual(first);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("retries after the timed-out callback settles and the cache expires", async () => {
    let currentTime = 0;
    let settle: (() => void) | undefined;
    const check = vi.fn(
      () =>
        new Promise<{ status: "True"; reason: string; message: string }>((resolve) => {
          settle = () => resolve({ status: "True", reason: "StorageReady", message: "Ready." });
        }),
    );
    const criterion = registration(check);
    const registry = { readinessCriteria: [criterion] };
    const config = {};
    const resolve = createPluginReadinessResolver({
      timeoutMs: 5,
      cacheTtlMs: 10,
      now: () => currentTime,
    });

    await resolve({ registry, config });
    settle?.();
    await new Promise((resolveSettled) => {
      setTimeout(resolveSettled, 0);
    });
    currentTime = 20;
    await resolve({ registry, config });

    expect(check).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed and oversized provider output", async () => {
    const malformed = registration(() => ({
      status: "False",
      reason: "Bad\nReason",
      message: "password=super-secret-value-that-must-not-escape",
    }));
    const oversized = registration(() => ({
      status: "False",
      reason: "StorageUnavailable",
      message: "x".repeat(513),
    }));
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 0 });

    await expect(
      resolve({ registry: { readinessCriteria: [malformed] }, config: {} }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "Unknown", reason: "CriterionInvalidResult" }),
    ]);
    await expect(
      resolve({ registry: { readinessCriteria: [oversized] }, config: {} }),
    ).resolves.toEqual([
      expect.objectContaining({ status: "Unknown", reason: "CriterionInvalidResult" }),
    ]);
  });

  it("redacts secrets from otherwise valid provider messages", async () => {
    const criterion = registration(() => ({
      status: "False",
      reason: "StorageUnavailable",
      message: "Storage failed with password=super-secret-value-that-must-not-escape",
    }));
    const resolve = createPluginReadinessResolver({ cacheTtlMs: 0 });

    const [condition] = await resolve({ registry: { readinessCriteria: [criterion] }, config: {} });

    expect(condition).toMatchObject({ status: "False", reason: "StorageUnavailable" });
    expect(condition?.message).not.toContain("super-secret-value-that-must-not-escape");
  });
});
