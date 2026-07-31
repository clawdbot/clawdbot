// Feishu tests cover provider-verified bot identity cache behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedFeishuBotIdentity, writeCachedFeishuBotIdentity } from "./bot-identity-cache.js";

const cacheHarness = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  openKeyedStore: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    state: {
      openKeyedStore: cacheHarness.openKeyedStore,
    },
  }),
}));

beforeEach(() => {
  cacheHarness.entries.clear();
  cacheHarness.openKeyedStore.mockReset().mockReturnValue({
    lookup: vi.fn(async (key: string) => cacheHarness.entries.get(key)),
    register: vi.fn(async (key: string, value: unknown) => {
      cacheHarness.entries.set(key, value);
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Feishu bot identity cache", () => {
  it("persists provider-verified identity in a bounded plugin-state namespace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T23:00:00.000Z"));

    await writeCachedFeishuBotIdentity({
      accountId: "person-2",
      appId: "cli_person_2",
      botOpenId: "ou_bot_person_2",
      botName: "OpenClaw QA",
    });

    await expect(
      readCachedFeishuBotIdentity({ accountId: "person-2", appId: "cli_person_2" }),
    ).resolves.toEqual({
      botOpenId: "ou_bot_person_2",
      botName: "OpenClaw QA",
      fetchedAt: "2026-07-22T23:00:00.000Z",
    });
    expect(cacheHarness.openKeyedStore).toHaveBeenCalledWith({
      namespace: "feishu.bot-identity-cache",
      maxEntries: 128,
    });
  });

  it("keeps identity across secret rotation but rejects a different app id", async () => {
    await writeCachedFeishuBotIdentity({
      accountId: "person-2",
      appId: "cli_person_2",
      botOpenId: "ou_bot_person_2",
    });

    await expect(
      readCachedFeishuBotIdentity({ accountId: "person-2", appId: "cli_person_2" }),
    ).resolves.toMatchObject({ botOpenId: "ou_bot_person_2" });
    await expect(
      readCachedFeishuBotIdentity({ accountId: "person-2", appId: "cli_replacement" }),
    ).resolves.toBeNull();
  });

  it("rejects malformed or incomplete persisted values", async () => {
    cacheHarness.entries.set("person-2", {
      appId: "cli_person_2",
      botOpenId: "ou_bot_person_2",
      fetchedAt: "not-a-date",
    });

    await expect(
      readCachedFeishuBotIdentity({ accountId: "person-2", appId: "cli_person_2" }),
    ).resolves.toBeNull();
  });

  it("does not persist an identity without both app and bot ids", async () => {
    await writeCachedFeishuBotIdentity({ accountId: "person-2", botOpenId: "ou_bot_person_2" });
    await writeCachedFeishuBotIdentity({ accountId: "person-2", appId: "cli_person_2" });

    expect(cacheHarness.entries.size).toBe(0);
  });
});
