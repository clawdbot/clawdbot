import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSlackRuntime, setSlackRuntime } from "./runtime.js";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
  hasSlackThreadParticipationWithPersistence,
  recordSlackThreadParticipation,
} from "./sent-thread-cache.js";

describe("slack sent-thread-cache", () => {
  afterEach(() => {
    clearSlackThreadParticipationCache();
    clearSlackRuntime();
    vi.restoreAllMocks();
  });

  it("records and checks thread participation", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("returns false for unrecorded threads", () => {
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("distinguishes different channels and threads", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000002")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C456", "1700000000.000001")).toBe(false);
  });

  it("scopes participation by accountId", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    expect(hasSlackThreadParticipation("A2", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);
  });

  it("ignores empty accountId, channelId, or threadTs", () => {
    recordSlackThreadParticipation("", "C123", "1700000000.000001");
    recordSlackThreadParticipation("A1", "", "1700000000.000001");
    recordSlackThreadParticipation("A1", "C123", "");
    expect(hasSlackThreadParticipation("", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "")).toBe(false);
  });

  it("clears all entries", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    recordSlackThreadParticipation("A1", "C456", "1700000000.000002");
    clearSlackThreadParticipationCache();
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C456", "1700000000.000002")).toBe(false);
  });

  it("shares thread participation across distinct module instances", async () => {
    const cacheA = await importFreshModule<typeof import("./sent-thread-cache.js")>(
      import.meta.url,
      "./sent-thread-cache.js?scope=shared-a",
    );
    const cacheB = await importFreshModule<typeof import("./sent-thread-cache.js")>(
      import.meta.url,
      "./sent-thread-cache.js?scope=shared-b",
    );

    cacheA.clearSlackThreadParticipationCache();

    try {
      cacheA.recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
      expect(cacheB.hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(true);

      cacheB.clearSlackThreadParticipationCache();
      expect(cacheA.hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
    } finally {
      cacheA.clearSlackThreadParticipationCache();
    }
  });

  it("expired entries return false and are cleaned up on read", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001");
    // Advance time past the 24-hour TTL
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("enforces maximum entries by evicting oldest fresh entries", () => {
    for (let i = 0; i < 5001; i += 1) {
      recordSlackThreadParticipation("A1", "C123", `1700000000.${String(i).padStart(6, "0")}`);
    }

    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000000")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.005000")).toBe(true);
  });

  it("writes and reads persistent thread participation when runtime state is available", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue({ repliedAt: 123 });
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setSlackRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordSlackThreadParticipation("A1", "C123", "1700000000.000002");

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith(
      "A1:C123:1700000000.000002",
      expect.objectContaining({ repliedAt: expect.any(Number) }),
    );

    clearSlackThreadParticipationCache();
    await expect(
      hasSlackThreadParticipationWithPersistence({
        accountId: "A1",
        channelId: "C123",
        threadTs: "1700000000.000002",
      }),
    ).resolves.toBe(true);
    expect(openKeyedStore).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith("A1:C123:1700000000.000002");

    lookup.mockClear();
    await expect(
      hasSlackThreadParticipationWithPersistence({
        accountId: "A1",
        channelId: "C123",
        threadTs: "1700000000.000002",
      }),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls back to in-memory thread participation when persistent state cannot open", async () => {
    const warn = vi.fn();
    setSlackRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    recordSlackThreadParticipation("A1", "C123", "1700000000.000003");
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000003")).toBe(true);

    clearSlackThreadParticipationCache();
    await expect(
      hasSlackThreadParticipationWithPersistence({
        accountId: "A1",
        channelId: "C123",
        threadTs: "1700000000.000003",
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
