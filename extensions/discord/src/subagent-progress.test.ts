// Discord tests cover portable subagent progress presentation.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleDiscordSubagentProgress,
  recoverDiscordSubagentProgress,
} from "./subagent-progress.js";

const sendMocks = vi.hoisted(() => ({
  react: vi.fn(async (_channelId: string, _messageId: string, _emoji: string, _opts: unknown) => ({
    ok: true,
  })),
  remove: vi.fn(async (_channelId: string, _messageId: string, _emoji: string, _opts: unknown) => ({
    ok: true,
  })),
  typing: vi.fn(async (_channelId: string, _opts: unknown) => ({
    ok: true,
    channelId: "123",
  })),
}));

const resetDiscordSubagentProgressForTest = handleDiscordSubagentProgress.resetForTest;

vi.mock("./send.reactions.js", () => ({
  reactMessageDiscord: sendMocks.react,
  removeReactionDiscord: sendMocks.remove,
}));
vi.mock("./send.typing.js", () => ({ sendTypingDiscord: sendMocks.typing }));

type StoredProgressRunBase = {
  key: string;
  accountId: string;
  channelId: string;
  messageId: string;
  runningEmoji?: string;
};

type StoredProgressRun = StoredProgressRunBase &
  (
    | { status: "active" }
    | { status: "cleanup"; outcome: "ok" | "error" | "timeout" | "killed" | "unknown" }
  );

function createProgressStore() {
  const values = new Map<string, StoredProgressRun>();
  return {
    values,
    store: {
      register: vi.fn(async (key: string, value: StoredProgressRun) => {
        values.set(key, value);
      }),
      registerIfAbsent: vi.fn(async (key: string, value: StoredProgressRun) => {
        if (values.has(key)) {
          return false;
        }
        values.set(key, value);
        return true;
      }),
      lookup: vi.fn(async (key: string) => values.get(key)),
      consume: vi.fn(async (key: string) => {
        const value = values.get(key);
        values.delete(key);
        return value;
      }),
      delete: vi.fn(async (key: string) => values.delete(key)),
      entries: vi.fn(async () =>
        Array.from(values, ([key, value]) => ({ key, value, createdAt: Date.now() })),
      ),
      clear: vi.fn(async () => {
        values.clear();
      }),
    } satisfies PluginStateKeyedStore<StoredProgressRun>,
  };
}

function createApi(config?: Record<string, unknown>) {
  const progressStore = createProgressStore();
  const openKeyedStore = vi.fn(<T>() => progressStore.store as unknown as PluginStateKeyedStore<T>);
  const api = {
    config: config ?? {
      channels: { discord: { token: "test-token", subagentProgress: true } },
    },
    logger: { debug: vi.fn() },
    runtime: {
      state: {
        openKeyedStore,
      },
    },
  } as unknown as Parameters<typeof handleDiscordSubagentProgress>[0];
  return {
    api,
    progressStore,
    openKeyedStore,
  };
}

let api: ReturnType<typeof createApi>["api"];
let progressStore: ReturnType<typeof createProgressStore>;

function started(runId: string) {
  return {
    phase: "started" as const,
    runId,
    requester: {
      channel: "discord",
      accountId: "default",
      to: "channel:123",
      messageId: "456",
    },
  };
}

describe("Discord subagent progress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ({ api, progressStore } = createApi());
    sendMocks.react.mockReset().mockResolvedValue({ ok: true });
    sendMocks.remove.mockReset().mockResolvedValue({ ok: true });
    sendMocks.typing.mockReset().mockResolvedValue({ ok: true, channelId: "123" });
  });

  afterEach(() => {
    resetDiscordSubagentProgressForTest();
    vi.useRealTimers();
  });

  it("updates one source-message count reaction for concurrent runs", async () => {
    await handleDiscordSubagentProgress(api, started("run-1"));
    await handleDiscordSubagentProgress(api, started("run-2"));
    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-1",
      outcome: "ok",
    });
    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-2",
      outcome: "ok",
    });

    expect(sendMocks.react.mock.calls.map((call) => call[2])).toEqual(["1️⃣", "2️⃣", "1️⃣"]);
    expect(sendMocks.remove.mock.calls.map((call) => call[2])).toEqual(["1️⃣", "2️⃣", "1️⃣"]);
  });

  it("refreshes reaction ownership inside the source queue for concurrent endings", async () => {
    await handleDiscordSubagentProgress(api, started("run-one"));
    await handleDiscordSubagentProgress(api, started("run-two"));
    sendMocks.remove.mockImplementation(async (_channelId, _messageId, emoji) => ({
      ok: emoji !== "1️⃣" || sendMocks.remove.mock.calls.length !== 3,
    }));

    await Promise.all([
      handleDiscordSubagentProgress(api, { phase: "ended", runId: "run-one", outcome: "ok" }),
      handleDiscordSubagentProgress(api, { phase: "ended", runId: "run-two", outcome: "ok" }),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(progressStore.values.size).toBe(0);
  });

  it("adds the internal failure marker after clearing the running count", async () => {
    await handleDiscordSubagentProgress(api, started("run-error"));
    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-error",
      outcome: "error",
    });

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "🔴", expect.any(Object));
  });

  it("clears a count reaction whose successful add response was lost", async () => {
    sendMocks.react.mockResolvedValueOnce({ ok: false });

    await handleDiscordSubagentProgress(api, started("run-ambiguous-add"));
    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-ambiguous-add",
      outcome: "ok",
    });

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(progressStore.values.has("run-ambiguous-add")).toBe(false);
  });

  it("retries an unconfirmed replacement count reaction", async () => {
    await handleDiscordSubagentProgress(api, started("run-one"));
    await handleDiscordSubagentProgress(api, started("run-two"));
    sendMocks.react.mockResolvedValueOnce({ ok: false });

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-two",
      outcome: "ok",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMocks.react.mock.calls.filter((call) => call[2] === "1️⃣")).toHaveLength(3);
    expect(progressStore.values.has("run-two")).toBe(false);
  });

  it("keeps typing alive only while the source has active runs", async () => {
    await handleDiscordSubagentProgress(api, started("run-typing"));
    expect(sendMocks.typing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_500);
    expect(sendMocks.typing).toHaveBeenCalledTimes(2);

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-typing",
      outcome: "ok",
    });
    await vi.advanceTimersByTimeAsync(8_500);
    expect(sendMocks.typing).toHaveBeenCalledTimes(2);
  });

  it("does nothing unless the single enable toggle is true", async () => {
    await handleDiscordSubagentProgress(
      createApi({ channels: { discord: { token: "test-token" } } }).api,
      started("run-disabled"),
    );

    expect(sendMocks.react).not.toHaveBeenCalled();
    expect(sendMocks.typing).not.toHaveBeenCalled();
  });

  it("ignores a started event that arrives after its terminal event", async () => {
    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-raced",
      outcome: "ok",
    });
    await handleDiscordSubagentProgress(api, started("run-raced"));

    expect(sendMocks.react).not.toHaveBeenCalled();
    expect(sendMocks.typing).not.toHaveBeenCalled();
  });

  it("restores durable ownership to clear a running reaction after restart", async () => {
    await handleDiscordSubagentProgress(api, started("run-restart"));
    resetDiscordSubagentProgressForTest();

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-restart",
      outcome: "ok",
    });

    expect(progressStore.values.size).toBe(0);
    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
  });

  it("restores typing for sibling runs when one ends after restart", async () => {
    await handleDiscordSubagentProgress(api, started("run-sibling"));
    await handleDiscordSubagentProgress(api, started("run-ending"));
    resetDiscordSubagentProgressForTest();
    sendMocks.react.mockClear();
    sendMocks.typing.mockClear();

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-ending",
      outcome: "ok",
    });

    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.typing).toHaveBeenCalledTimes(1);
  });

  it("does not restore sibling typing after the feature is disabled", async () => {
    await handleDiscordSubagentProgress(api, started("run-sibling"));
    await handleDiscordSubagentProgress(api, started("run-ending"));
    resetDiscordSubagentProgressForTest();
    sendMocks.typing.mockClear();
    api.config = { channels: { discord: { token: "test-token", subagentProgress: false } } };

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-ending",
      outcome: "ok",
    });

    expect(sendMocks.typing).not.toHaveBeenCalled();
  });

  it("restores active counts before presenting a new run after restart", async () => {
    await handleDiscordSubagentProgress(api, started("run-before-restart"));
    resetDiscordSubagentProgressForTest();

    await handleDiscordSubagentProgress(api, started("run-after-restart"));

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "2️⃣", expect.any(Object));
  });

  it("rebuilds a restored count when durable state outran Discord presentation", async () => {
    await handleDiscordSubagentProgress(api, started("run-visible"));
    progressStore.values.set("run-not-visible", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "active",
    });
    resetDiscordSubagentProgressForTest();
    sendMocks.remove.mockClear();

    await handleDiscordSubagentProgress(api, started("run-after-restart"));

    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.remove).not.toHaveBeenCalledWith("123", "456", "2️⃣", expect.any(Object));
    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "3️⃣", expect.any(Object));
  });

  it("keeps failed terminal cleanup durable until the next source event", async () => {
    await handleDiscordSubagentProgress(api, started("run-cleanup"));
    sendMocks.remove.mockRejectedValueOnce(new Error("transient Discord failure"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-cleanup",
      outcome: "ok",
    });

    expect(progressStore.values.get("run-cleanup")?.status).toBe("cleanup");
    resetDiscordSubagentProgressForTest();

    await handleDiscordSubagentProgress(api, started("run-after-cleanup"));

    expect(progressStore.values.has("run-cleanup")).toBe(false);
    expect(progressStore.values.get("run-after-cleanup")?.status).toBe("active");
    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "1️⃣", expect.any(Object));
  });

  it("retries failed terminal reaction cleanup without another source event", async () => {
    await handleDiscordSubagentProgress(api, started("run-retry-cleanup"));
    sendMocks.remove.mockRejectedValueOnce(new Error("transient Discord failure"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-retry-cleanup",
      outcome: "ok",
    });
    expect(progressStore.values.get("run-retry-cleanup")?.status).toBe("cleanup");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(progressStore.values.has("run-retry-cleanup")).toBe(false);
    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
  });

  it("retries a resolved false terminal reaction removal", async () => {
    await handleDiscordSubagentProgress(api, started("run-false-cleanup"));
    sendMocks.remove.mockResolvedValueOnce({ ok: false });

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-false-cleanup",
      outcome: "ok",
    });
    expect(progressStore.values.get("run-false-cleanup")?.status).toBe("cleanup");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(progressStore.values.has("run-false-cleanup")).toBe(false);
  });

  it("retries a failed terminal outcome marker before consuming ownership", async () => {
    await handleDiscordSubagentProgress(api, started("run-failure-marker"));
    sendMocks.react.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-failure-marker",
      outcome: "error",
    });
    expect(progressStore.values.get("run-failure-marker")).toMatchObject({
      status: "cleanup",
      outcome: "error",
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(progressStore.values.has("run-failure-marker")).toBe(false);
    expect(sendMocks.react.mock.calls.filter((call) => call[2] === "🔴")).toHaveLength(2);
  });

  it("preserves cleanup ownership when a retry refresh lookup fails", async () => {
    await handleDiscordSubagentProgress(api, started("run-refresh-error"));
    sendMocks.remove.mockResolvedValueOnce({ ok: false });

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-refresh-error",
      outcome: "ok",
    });
    progressStore.store.lookup.mockImplementationOnce(async (key) => progressStore.values.get(key));
    progressStore.store.lookup.mockRejectedValueOnce(new Error("state store unavailable"));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMocks.remove).toHaveBeenLastCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(progressStore.values.has("run-refresh-error")).toBe(false);
  });

  it("bounds permanent terminal reaction retries while retaining ownership", async () => {
    await handleDiscordSubagentProgress(api, started("run-permanent-failure"));
    sendMocks.remove.mockResolvedValue({ ok: false });

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-permanent-failure",
      outcome: "ok",
    });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(sendMocks.remove).toHaveBeenCalledTimes(13);
    expect(progressStore.values.get("run-permanent-failure")?.status).toBe("cleanup");
  });

  it("recovers durable cleanup rows on gateway startup", async () => {
    progressStore.values.set("run-restart-cleanup", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
      runningEmoji: "1️⃣",
    });

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(progressStore.values.has("run-restart-cleanup")).toBe(false);
  });

  it("restores a persisted terminal outcome marker on gateway startup", async () => {
    progressStore.values.set("run-restart-timeout", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "timeout",
      runningEmoji: "1️⃣",
    });

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.react).toHaveBeenCalledWith("123", "456", "🔴", expect.any(Object));
    expect(progressStore.values.has("run-restart-timeout")).toBe(false);
  });

  it("cleans interrupted active rows on gateway startup", async () => {
    progressStore.values.set("run-interrupted", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "active",
      runningEmoji: "1️⃣",
    });

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(progressStore.values.has("run-interrupted")).toBe(false);
  });

  it("does not remove a progress glyph newly reserved by configuration", async () => {
    const collision = createApi({
      messages: { ackReaction: "1️⃣" },
      channels: { discord: { token: "test-token", subagentProgress: true } },
    });
    collision.progressStore.values.set("run-collision-cleanup", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
      runningEmoji: "1️⃣",
    });

    await recoverDiscordSubagentProgress(collision.api);

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(sendMocks.remove).not.toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(collision.progressStore.values.has("run-collision-cleanup")).toBe(false);
  });

  it("removes owned progress reactions after the feature is disabled", async () => {
    const disabled = createApi({ channels: { discord: { token: "test-token" } } });
    disabled.progressStore.values.set("run-disabled-cleanup", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
      runningEmoji: "1️⃣",
    });

    await recoverDiscordSubagentProgress(disabled.api);

    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(disabled.progressStore.values.has("run-disabled-cleanup")).toBe(false);
  });

  it("stops live presentation when the feature is disabled", async () => {
    await handleDiscordSubagentProgress(api, started("run-one"));
    await handleDiscordSubagentProgress(api, started("run-two"));
    api.config.channels!.discord!.subagentProgress = false;
    sendMocks.react.mockClear();
    sendMocks.remove.mockClear();
    const typingCalls = sendMocks.typing.mock.calls.length;

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-two",
      outcome: "error",
    });
    await vi.advanceTimersByTimeAsync(8_500);

    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(sendMocks.react).not.toHaveBeenCalled();
    expect(sendMocks.typing).toHaveBeenCalledTimes(typingCalls);
  });

  it("tears down live presentation when a disabled start arrives", async () => {
    await handleDiscordSubagentProgress(api, started("run-active"));
    api.config.channels!.discord!.subagentProgress = false;
    sendMocks.remove.mockClear();
    const typingCalls = sendMocks.typing.mock.calls.length;

    await handleDiscordSubagentProgress(api, started("run-ignored"));
    await vi.advanceTimersByTimeAsync(8_500);

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.typing).toHaveBeenCalledTimes(typingCalls);
    expect(progressStore.values.has("run-ignored")).toBe(false);
  });

  it("retains cleanup ownership while the Discord account is disabled", async () => {
    const disabled = createApi({
      channels: {
        discord: { enabled: false, token: "test-token", subagentProgress: true },
      },
    });
    disabled.progressStore.values.set("run-account-disabled", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
      runningEmoji: "1️⃣",
    });

    await recoverDiscordSubagentProgress(disabled.api);

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(disabled.progressStore.values.get("run-account-disabled")?.status).toBe("cleanup");
  });

  it("retries startup recovery after a transient state listing failure", async () => {
    progressStore.values.set("run-list-retry", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
      runningEmoji: "1️⃣",
    });
    progressStore.store.entries.mockRejectedValueOnce(new Error("state store unavailable"));

    await recoverDiscordSubagentProgress(api);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(progressStore.store.entries).toHaveBeenCalledTimes(3);
    expect(progressStore.values.has("run-list-retry")).toBe(false);
  });

  it("uses listed ownership when startup lookup fails transiently", async () => {
    progressStore.values.set("run-lookup-recovery", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
      runningEmoji: "1️⃣",
    });
    progressStore.store.lookup.mockRejectedValueOnce(new Error("state store unavailable"));

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(progressStore.values.has("run-lookup-recovery")).toBe(false);
  });

  it("rebuilds presentation for a duplicate start replayed after restart", async () => {
    await handleDiscordSubagentProgress(api, started("run-replayed"));
    resetDiscordSubagentProgressForTest();
    sendMocks.react.mockClear();
    sendMocks.remove.mockClear();
    sendMocks.typing.mockClear();

    await handleDiscordSubagentProgress(api, started("run-replayed"));

    expect(progressStore.values.size).toBe(1);
    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.typing).toHaveBeenCalledTimes(1);
  });

  it("retains cleanup when restoring the remaining count fails", async () => {
    await handleDiscordSubagentProgress(api, started("run-remaining"));
    await handleDiscordSubagentProgress(api, started("run-ending"));
    resetDiscordSubagentProgressForTest();
    sendMocks.react.mockRejectedValueOnce(new Error("transient Discord failure"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-ending",
      outcome: "ok",
    });

    expect(progressStore.values.get("run-remaining")?.status).toBe("active");
    expect(progressStore.values.get("run-ending")?.status).toBe("cleanup");
  });

  it("persists a replacement count before adding it during restart recovery", async () => {
    await handleDiscordSubagentProgress(api, started("run-remaining"));
    await handleDiscordSubagentProgress(api, started("run-ending"));
    resetDiscordSubagentProgressForTest();

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-ending",
      outcome: "ok",
    });

    expect(progressStore.values.get("run-remaining")?.runningEmoji).toBe("1️⃣");
    resetDiscordSubagentProgressForTest();
    sendMocks.remove.mockClear();
    await recoverDiscordSubagentProgress(api);
    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
  });

  it("does not resurrect a durable cleanup row on a replayed start", async () => {
    progressStore.values.set("run-terminal", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
    });

    await handleDiscordSubagentProgress(api, started("run-terminal"));

    expect(progressStore.values.has("run-terminal")).toBe(false);
    expect(sendMocks.react).not.toHaveBeenCalled();
    expect(sendMocks.typing).not.toHaveBeenCalled();
  });

  it("restores other active runs when a terminal start is replayed", async () => {
    progressStore.values.set("run-active", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "active",
    });
    progressStore.values.set("run-terminal", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
    });

    await handleDiscordSubagentProgress(api, started("run-terminal"));

    expect(progressStore.values.has("run-terminal")).toBe(false);
    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.typing).toHaveBeenCalledTimes(1);
  });

  it("still clears in-memory presentation when cleanup marking fails", async () => {
    await handleDiscordSubagentProgress(api, started("run-store-error"));
    progressStore.store.register.mockRejectedValueOnce(new Error("state store unavailable"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-store-error",
      outcome: "ok",
    });
    await vi.advanceTimersByTimeAsync(8_500);

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.typing).toHaveBeenCalledTimes(1);
    expect(progressStore.values.has("run-store-error")).toBe(false);
  });

  it("excludes the ending row when cleanup marking fails after restart", async () => {
    await handleDiscordSubagentProgress(api, started("run-store-error"));
    resetDiscordSubagentProgressForTest();
    sendMocks.react.mockClear();
    sendMocks.remove.mockClear();
    progressStore.store.register.mockRejectedValueOnce(new Error("state store unavailable"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-store-error",
      outcome: "ok",
    });

    expect(sendMocks.remove).toHaveBeenCalledTimes(1);
    expect(sendMocks.react).not.toHaveBeenCalled();
    expect(progressStore.values.has("run-store-error")).toBe(false);
  });

  it("retains cleanup without mutating reactions when state listing fails", async () => {
    await handleDiscordSubagentProgress(api, started("run-list-error"));
    resetDiscordSubagentProgressForTest();
    sendMocks.remove.mockClear();
    progressStore.store.entries.mockRejectedValueOnce(new Error("state store unavailable"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-list-error",
      outcome: "ok",
    });

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(progressStore.values.get("run-list-error")?.status).toBe("cleanup");
  });

  it("repairs an in-memory run after a durable lookup failure", async () => {
    await handleDiscordSubagentProgress(api, started("run-lookup-error"));
    progressStore.store.lookup.mockRejectedValueOnce(new Error("state store unavailable"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-lookup-error",
      outcome: "ok",
    });

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(progressStore.values.has("run-lookup-error")).toBe(false);
  });

  it("retries a terminal lookup after restart", async () => {
    await handleDiscordSubagentProgress(api, started("run-lookup-retry"));
    resetDiscordSubagentProgressForTest();
    sendMocks.remove.mockClear();
    progressStore.store.lookup.mockRejectedValueOnce(new Error("state store unavailable"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-lookup-retry",
      outcome: "ok",
      requester: started("ignored").requester,
    });
    expect(sendMocks.remove).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMocks.remove).toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(progressStore.values.has("run-lookup-retry")).toBe(false);
  });

  it("reopens the state store after a transient open failure", async () => {
    const reopened = createApi();
    api = reopened.api;
    progressStore = reopened.progressStore;
    progressStore.values.set("run-open-retry", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "active",
    });
    reopened.openKeyedStore.mockImplementationOnce(() => {
      throw new Error("state store unavailable");
    });

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-open-retry",
      outcome: "ok",
      requester: started("ignored").requester,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(reopened.openKeyedStore).toHaveBeenCalledTimes(2);
    expect(progressStore.values.has("run-open-retry")).toBe(false);
  });

  it("does not retry an unowned non-Discord terminal event", async () => {
    progressStore.store.lookup.mockRejectedValue(new Error("state store unavailable"));

    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-slack",
      outcome: "ok",
      requester: { channel: "slack", channelId: "123", messageId: "456" },
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(progressStore.store.lookup).toHaveBeenCalledTimes(1);
  });

  it("never reconciles reactions for a typing-only tracker", async () => {
    const typingOnly = createApi();
    typingOnly.progressStore.store.registerIfAbsent.mockRejectedValueOnce(
      new Error("state store unavailable"),
    );

    await handleDiscordSubagentProgress(typingOnly.api, started("run-typing-only"));
    await handleDiscordSubagentProgress(typingOnly.api, {
      phase: "ended",
      runId: "run-typing-only",
      outcome: "ok",
    });

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(sendMocks.typing).toHaveBeenCalledTimes(1);
  });

  it("defers a new start when restored state cannot be listed", async () => {
    progressStore.values.set("run-existing", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "active",
    });
    progressStore.store.entries.mockRejectedValueOnce(new Error("state store unavailable"));

    await handleDiscordSubagentProgress(api, started("run-deferred"));

    expect(progressStore.values.has("run-deferred")).toBe(false);
    expect(sendMocks.react).not.toHaveBeenCalled();
    expect(sendMocks.typing).not.toHaveBeenCalled();
  });

  it("keeps consumed cleanup rows as process terminal tombstones", async () => {
    progressStore.values.set("run-terminal", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
    });

    await handleDiscordSubagentProgress(api, started("run-other"));
    await handleDiscordSubagentProgress(api, started("run-terminal"));

    expect(progressStore.values.has("run-terminal")).toBe(false);
    expect(progressStore.values.get("run-other")?.status).toBe("active");
    expect(sendMocks.react).toHaveBeenLastCalledWith("123", "456", "1️⃣", expect.any(Object));
  });

  it("does not overwrite a cleanup tombstone while a sibling tracker is active", async () => {
    await handleDiscordSubagentProgress(api, started("run-active"));
    progressStore.values.set("run-terminal", {
      key: "default:123:456",
      accountId: "default",
      channelId: "123",
      messageId: "456",
      status: "cleanup",
      outcome: "ok",
    });
    sendMocks.react.mockClear();

    await handleDiscordSubagentProgress(api, started("run-terminal"));

    expect(progressStore.values.get("run-terminal")?.status).toBe("cleanup");
    expect(sendMocks.react).not.toHaveBeenCalled();
  });

  it("does not treat a terminal-event locator as reaction ownership", async () => {
    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-terminal-locator",
      outcome: "ok",
      requester: started("ignored").requester,
    });

    expect(sendMocks.remove).not.toHaveBeenCalled();
  });

  it("keeps reactions off when an agent identity owns a progress emoji", async () => {
    const collisionApi = createApi({
      agents: { list: [{ id: "main", identity: { emoji: "1️⃣" } }] },
      channels: { discord: { token: "test-token", subagentProgress: true } },
    }).api;

    await handleDiscordSubagentProgress(collisionApi, started("run-collision"));

    expect(sendMocks.react).not.toHaveBeenCalled();
    expect(sendMocks.typing).toHaveBeenCalledTimes(1);
  });

  it("preserves a live progress glyph newly reserved by configuration", async () => {
    await handleDiscordSubagentProgress(api, started("run-before-reload"));
    api.config.messages = { ackReaction: "1️⃣" };
    sendMocks.react.mockClear();
    sendMocks.remove.mockClear();

    await handleDiscordSubagentProgress(api, started("run-after-reload"));
    await handleDiscordSubagentProgress(api, {
      phase: "ended",
      runId: "run-before-reload",
      outcome: "ok",
    });

    expect(sendMocks.remove).not.toHaveBeenCalledWith("123", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.react).not.toHaveBeenCalled();
  });

  it("retains ownership when collision cleanup fails", async () => {
    await handleDiscordSubagentProgress(api, started("run-before-collision"));
    api.config.messages = { ackReaction: "2️⃣" };
    sendMocks.remove.mockResolvedValueOnce({ ok: false });

    await handleDiscordSubagentProgress(api, started("run-after-collision"));

    expect(progressStore.values.get("run-before-collision")?.runningEmoji).toBe("1️⃣");
    expect(progressStore.values.has("run-after-collision")).toBe(false);
  });

  it("uses the native source channel for Discord DM routes", async () => {
    await handleDiscordSubagentProgress(api, {
      ...started("run-dm"),
      requester: {
        channel: "discord",
        accountId: "default",
        to: "user:789",
        channelId: "987",
        messageId: "456",
      },
    });

    expect(sendMocks.react).toHaveBeenCalledWith("987", "456", "1️⃣", expect.any(Object));
    expect(sendMocks.typing).toHaveBeenCalledWith("987", expect.any(Object));
  });
});
