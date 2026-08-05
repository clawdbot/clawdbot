// Telegram tests cover poll registry plugin behavior.
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findTelegramPollRegistryEntry,
  recordTelegramPollRegistryEntry,
  retireTelegramPollRegistryEntry,
} from "./poll-registry.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 10_000;

type TelegramPollRegistryEntry = {
  pollId: string;
  chat: { id: number; type: "private"; first_name: string };
  messageId: number;
  messageThreadId?: number;
  question: string;
  options: string[];
};

function installTelegramStateRuntime(
  openKeyedStore: TelegramRuntime["state"]["openKeyedStore"],
): void {
  setTelegramRuntime({
    state: { openKeyedStore },
    channel: {},
  } as TelegramRuntime);
}

describe("telegram poll registry", () => {
  beforeEach(async () => {
    const store = createPluginStateKeyedStoreForTests<TelegramPollRegistryEntry>("telegram", {
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await store.clear();
    installTelegramStateRuntime(((options) =>
      createPluginStateKeyedStoreForTests(
        "telegram",
        options,
      )) as TelegramRuntime["state"]["openKeyedStore"]);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTelegramRuntimeForTest();
    resetPluginStateStoreForTests();
  });

  it("stores and retrieves poll registry entries", async () => {
    await recordTelegramPollRegistryEntry({
      pollId: "poll-1",
      chat: { id: 123, type: "private", first_name: "Ada" },
      messageId: 44,
      messageThreadId: 77,
      question: "Ready?",
      options: ["Yes", "No"],
    });

    await expect(findTelegramPollRegistryEntry({ pollId: "poll-1" })).resolves.toEqual(
      expect.objectContaining({
        pollId: "poll-1",
        chat: { id: 123, type: "private", first_name: "Ada" },
        messageId: 44,
        messageThreadId: 77,
        question: "Ready?",
        options: ["Yes", "No"],
      }),
    );
  });

  it("returns null for an unknown poll id", async () => {
    await expect(findTelegramPollRegistryEntry({ pollId: "missing" })).resolves.toBeNull();
  });

  it("reclaims a closed poll after the durable replay grace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T00:00:00.000Z"));
    await recordTelegramPollRegistryEntry({
      pollId: "poll-closed",
      chat: { id: 123, type: "private", first_name: "Ada" },
      messageId: 44,
      question: "Ready?",
      options: ["Yes", "No"],
    });

    await retireTelegramPollRegistryEntry({ pollId: "poll-closed" });
    vi.setSystemTime(new Date("2026-08-06T23:59:59.999Z"));
    await expect(findTelegramPollRegistryEntry({ pollId: "poll-closed" })).resolves.not.toBeNull();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.001Z"));
    await expect(findTelegramPollRegistryEntry({ pollId: "poll-closed" })).resolves.toBeNull();
  });

  it("leaves unknown closed polls alone", async () => {
    await expect(retireTelegramPollRegistryEntry({ pollId: "missing" })).resolves.toBeUndefined();
  });

  it("rejects malformed stored origin data", async () => {
    installTelegramStateRuntime((() => ({
      lookup: async () => ({
        pollId: "poll-invalid-chat",
        chat: { id: "not-a-chat", type: "private", first_name: "Ada" },
        messageId: 44,
        question: "Ready?",
        options: ["Yes", "No"],
      }),
    })) as unknown as TelegramRuntime["state"]["openKeyedStore"]);

    await expect(
      findTelegramPollRegistryEntry({ pollId: "poll-invalid-chat" }),
    ).resolves.toBeNull();
  });

  it("propagates store lookup failures so durable ingress can retry", async () => {
    const readError = new Error("registry db unavailable");
    const failingStore = {
      lookup: async () => {
        throw readError;
      },
    } as unknown as PluginStateKeyedStore<TelegramPollRegistryEntry>;
    installTelegramStateRuntime((() => failingStore) as TelegramRuntime["state"]["openKeyedStore"]);

    await expect(findTelegramPollRegistryEntry({ pollId: "poll-read-error" })).rejects.toBe(
      readError,
    );
  });
});
