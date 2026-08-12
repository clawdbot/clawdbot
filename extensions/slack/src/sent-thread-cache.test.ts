// Slack tests cover sent thread cache plugin behavior.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSlackRuntime } from "./runtime.js";
import {
  clearSlackThreadFailureNotice,
  clearSlackThreadParticipationCache,
  hasSlackThreadFailureNotice,
  hasSlackThreadParticipation,
  hasSlackThreadParticipationWithPersistence,
  recordSlackThreadFailureNotice,
  recordSlackThreadParticipation,
} from "./sent-thread-cache.js";

describe("slack sent-thread-cache", () => {
  afterEach(() => {
    clearSlackThreadParticipationCache();
    setSlackRuntime(null as never);
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

  it("scopes participation by enterprise workspace without matching unscoped threads", () => {
    recordSlackThreadParticipation("A1", "C123", "1700000000.000001", { teamId: "T1" });

    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001", "T1")).toBe(true);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001", "T2")).toBe(false);
    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("announces a repeated thread failure only once until its message changes", () => {
    const notice = {
      accountId: "A1",
      channelId: "C123",
      threadTs: "1700000000.000001",
      failureText: "Model login expired",
    };

    expect(recordSlackThreadFailureNotice(notice)).toBe(true);
    expect(recordSlackThreadFailureNotice(notice)).toBe(false);
    expect(
      recordSlackThreadFailureNotice({ ...notice, failureText: "Model   login\nexpired" }),
    ).toBe(false);
    expect(
      recordSlackThreadFailureNotice({ ...notice, failureText: "App server unavailable" }),
    ).toBe(true);
    expect(recordSlackThreadFailureNotice(notice)).toBe(true);
  });

  it("checks a failure without marking it delivered", () => {
    const notice = {
      accountId: "A1",
      channelId: "C123",
      threadTs: "1700000000.000001",
      failureText: "Model login expired",
    };

    expect(hasSlackThreadFailureNotice(notice)).toBe(false);
    expect(hasSlackThreadFailureNotice(notice)).toBe(false);
    expect(recordSlackThreadFailureNotice(notice)).toBe(true);
    expect(hasSlackThreadFailureNotice(notice)).toBe(true);
    expect(hasSlackThreadFailureNotice({ ...notice, failureText: "Model  login\nexpired" })).toBe(
      true,
    );
    expect(hasSlackThreadFailureNotice({ ...notice, failureText: "App server unavailable" })).toBe(
      false,
    );
  });

  it("deduplicates top-level failures per channel without mixing them with threads", () => {
    const channelNotice = {
      accountId: "A1",
      channelId: "C123",
      failureText: "Model login expired",
      teamId: "T1",
    };

    expect(hasSlackThreadFailureNotice(channelNotice)).toBe(false);
    expect(recordSlackThreadFailureNotice(channelNotice)).toBe(true);
    expect(hasSlackThreadFailureNotice(channelNotice)).toBe(true);
    expect(recordSlackThreadFailureNotice(channelNotice)).toBe(false);
    expect(hasSlackThreadFailureNotice({ ...channelNotice, channelId: "C456" })).toBe(false);
    expect(hasSlackThreadFailureNotice({ ...channelNotice, accountId: "A2" })).toBe(false);
    expect(hasSlackThreadFailureNotice({ ...channelNotice, teamId: "T2" })).toBe(false);
    expect(hasSlackThreadFailureNotice({ ...channelNotice, threadTs: "1700000000.000001" })).toBe(
      false,
    );

    clearSlackThreadFailureNotice(channelNotice);
    expect(hasSlackThreadFailureNotice(channelNotice)).toBe(false);
    expect(recordSlackThreadFailureNotice(channelNotice)).toBe(true);
  });

  it("does not deduplicate failures with empty text", () => {
    const notice = {
      accountId: "A1",
      channelId: "C123",
      failureText: "   ",
    };

    expect(hasSlackThreadFailureNotice(notice)).toBe(false);
    expect(recordSlackThreadFailureNotice(notice)).toBe(false);
  });

  it("isolates thread failures by account, channel, thread, and enterprise workspace", () => {
    const notice = {
      accountId: "A1",
      channelId: "C123",
      threadTs: "1700000000.000001",
      failureText: "Model login expired",
      teamId: "T1",
    };

    expect(recordSlackThreadFailureNotice(notice)).toBe(true);
    expect(recordSlackThreadFailureNotice({ ...notice, accountId: "A2" })).toBe(true);
    expect(recordSlackThreadFailureNotice({ ...notice, channelId: "C456" })).toBe(true);
    expect(recordSlackThreadFailureNotice({ ...notice, threadTs: "1700000000.000002" })).toBe(true);
    expect(recordSlackThreadFailureNotice({ ...notice, teamId: "T2" })).toBe(true);
    expect(recordSlackThreadFailureNotice(notice)).toBe(false);
  });

  it("allows the same thread failure again after a successful turn clears its notice", () => {
    const notice = {
      accountId: "A1",
      channelId: "C123",
      threadTs: "1700000000.000001",
      failureText: "Model login expired",
    };

    expect(recordSlackThreadFailureNotice(notice)).toBe(true);
    clearSlackThreadFailureNotice(notice);
    expect(recordSlackThreadFailureNotice(notice)).toBe(true);
  });

  it("does not treat failure notices as thread participation", () => {
    recordSlackThreadFailureNotice({
      accountId: "A1",
      channelId: "C123",
      threadTs: "1700000000.000001",
      failureText: "Model login expired",
    });

    expect(hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
  });

  it("bounds failure notices and evicts the oldest thread", () => {
    const firstNotice = {
      accountId: "A1",
      channelId: "C123",
      threadTs: "1700000000.000000",
      failureText: "Model login expired",
    };
    expect(recordSlackThreadFailureNotice(firstNotice)).toBe(true);

    for (let index = 1; index <= 1000; index += 1) {
      expect(
        recordSlackThreadFailureNotice({
          ...firstNotice,
          threadTs: `1700000000.${String(index).padStart(6, "0")}`,
        }),
      ).toBe(true);
    }

    expect(recordSlackThreadFailureNotice(firstNotice)).toBe(true);
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
      const failureNotice = {
        accountId: "A1",
        channelId: "C123",
        threadTs: "1700000000.000001",
        failureText: "Model login expired",
      };
      expect(cacheA.recordSlackThreadFailureNotice(failureNotice)).toBe(true);
      expect(cacheB.recordSlackThreadFailureNotice(failureNotice)).toBe(false);

      cacheB.clearSlackThreadParticipationCache();
      expect(cacheA.hasSlackThreadParticipation("A1", "C123", "1700000000.000001")).toBe(false);
      expect(cacheA.recordSlackThreadFailureNotice(failureNotice)).toBe(true);
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

    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_000);
    recordSlackThreadParticipation("A1", "C123", "1700000000.000002");

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith("A1:C123:1700000000.000002", {
      repliedAt: 1_711_406_400_000,
    });

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
