// Discord tests cover cleanup left by the retired subagent progress feature.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverDiscordSubagentProgress } from "./subagent-progress.js";

const sendMocks = vi.hoisted(() => ({
  remove: vi.fn(async (_channelId: string, _messageId: string, _emoji: string, _opts: unknown) => ({
    ok: true,
  })),
}));

vi.mock("./send.reactions.js", () => ({
  removeReactionDiscord: sendMocks.remove,
}));

type StoredProgressRun = {
  key: string;
  accountId: string;
  channelId: string;
  messageId: string;
  runningEmoji?: string;
  status: "active" | "cleanup";
  outcome?: "ok" | "error" | "timeout" | "killed" | "unknown";
};

function createProgressStore() {
  const values = new Map<string, StoredProgressRun>();
  const store = {
    register: vi.fn(async (key: string, value: StoredProgressRun) => {
      values.set(key, value);
    }),
    registerIfAbsent: vi.fn(async () => false),
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
    clear: vi.fn(async () => values.clear()),
  } satisfies PluginStateKeyedStore<StoredProgressRun>;
  return { values, store };
}

function createApi(discord: Record<string, unknown> = { token: "test-token" }) {
  const progressStore = createProgressStore();
  const openKeyedStore = vi.fn(<T>() => progressStore.store as unknown as PluginStateKeyedStore<T>);
  const api = {
    config: { channels: { discord } },
    logger: { debug: vi.fn() },
    runtime: { state: { openKeyedStore } },
  } as unknown as Parameters<typeof recoverDiscordSubagentProgress>[0];
  return { api, progressStore, openKeyedStore };
}

function storedRun(overrides: Partial<StoredProgressRun> = {}): StoredProgressRun {
  return {
    key: "default:123:456",
    accountId: "default",
    channelId: "123",
    messageId: "456",
    runningEmoji: "1️⃣",
    status: "active",
    ...overrides,
  };
}

describe("retired Discord subagent progress cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMocks.remove.mockReset().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    recoverDiscordSubagentProgress.resetForTest();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("opens the shipped namespace and cleans active and terminal beta3 rows", async () => {
    vi.stubEnv("VITEST", "");
    const { api, progressStore, openKeyedStore } = createApi();
    progressStore.values.set("active-run", storedRun());
    progressStore.values.set(
      "cleanup-run",
      storedRun({ status: "cleanup", outcome: "timeout", runningEmoji: "2️⃣" }),
    );

    await recoverDiscordSubagentProgress(api);

    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "subagent-progress",
      maxEntries: 4_096,
      overflowPolicy: "reject-new",
      defaultTtlMs: 7 * 24 * 60 * 60_000,
    });
    expect(sendMocks.remove.mock.calls.map((call) => call[2])).toEqual(["1️⃣", "2️⃣"]);
    expect(progressStore.values.size).toBe(0);
  });

  it("removes the external reaction before consuming persisted ownership", async () => {
    const { api, progressStore } = createApi();
    progressStore.values.set("owned-run", storedRun());
    sendMocks.remove.mockImplementationOnce(async () => {
      expect(progressStore.values.has("owned-run")).toBe(true);
      return { ok: true };
    });

    await recoverDiscordSubagentProgress(api);

    expect(progressStore.store.consume).toHaveBeenCalledWith("owned-run");
  });

  it("does not remove glyphs reserved by current reaction configuration", async () => {
    const { api, progressStore } = createApi({ token: "test-token", ackReaction: "1️⃣" });
    progressStore.values.set("reserved-run", storedRun());

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(progressStore.values.size).toBe(0);
  });

  it("does not use persisted state to remove a non-historical reaction", async () => {
    const { api, progressStore } = createApi();
    progressStore.values.set("unexpected-run", storedRun({ runningEmoji: "🔥" }));

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(progressStore.values.size).toBe(0);
  });

  it.each([
    ["disabled", { enabled: false, token: "test-token" }],
    ["missing credentials", {}],
    [
      "configured-unavailable credentials",
      { token: { source: "env", provider: "default", id: "MISSING_DISCORD_TOKEN" } },
    ],
  ])("retains ownership while the account is %s", async (_label, discord) => {
    const { api, progressStore } = createApi(discord);
    progressStore.values.set("pending-run", storedRun());

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(progressStore.values.has("pending-run")).toBe(true);
  });

  it("does not clean a removed named account with the current root bot", async () => {
    const { api, progressStore } = createApi({ token: "current-root-token" });
    progressStore.values.set("retired-run", storedRun({ accountId: "retired" }));

    await recoverDiscordSubagentProgress(api);

    expect(sendMocks.remove).not.toHaveBeenCalled();
    expect(progressStore.store.consume).not.toHaveBeenCalled();
    expect(progressStore.values.has("retired-run")).toBe(true);
  });

  it("retains ownership and retries a failed reaction cleanup", async () => {
    const { api, progressStore } = createApi();
    progressStore.values.set("retry-run", storedRun());
    sendMocks.remove.mockRejectedValueOnce(new Error("Discord unavailable"));

    await recoverDiscordSubagentProgress(api);
    expect(progressStore.values.has("retry-run")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMocks.remove).toHaveBeenCalledTimes(2);
    expect(progressStore.values.has("retry-run")).toBe(false);
  });

  it("retains ownership when the persistence cleanup fails", async () => {
    const { api, progressStore } = createApi();
    progressStore.values.set("retry-run", storedRun());
    progressStore.store.consume.mockRejectedValueOnce(new Error("state unavailable"));

    await recoverDiscordSubagentProgress(api);
    expect(progressStore.values.has("retry-run")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMocks.remove).toHaveBeenCalledTimes(2);
    expect(progressStore.values.has("retry-run")).toBe(false);
  });

  it("bounds retries while retaining failed cleanup ownership", async () => {
    const { api, progressStore } = createApi();
    progressStore.values.set("retry-run", storedRun());
    sendMocks.remove.mockRejectedValue(new Error("Discord unavailable"));

    await recoverDiscordSubagentProgress(api);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(sendMocks.remove).toHaveBeenCalledTimes(13);
    expect(progressStore.values.has("retry-run")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a transient state listing failure", async () => {
    const { api, progressStore } = createApi();
    progressStore.values.set("retry-run", storedRun());
    progressStore.store.entries.mockRejectedValueOnce(new Error("state unavailable"));

    await recoverDiscordSubagentProgress(api);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(progressStore.store.entries).toHaveBeenCalledTimes(2);
    expect(progressStore.values.has("retry-run")).toBe(false);
  });
});
