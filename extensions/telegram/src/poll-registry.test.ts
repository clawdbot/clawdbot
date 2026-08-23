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
  type TelegramPollRegistryEntry,
} from "./poll-registry.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 10_000;

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

  it.each([
    {
      name: "base private chat",
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      threadSpec: { scope: "dm" as const },
    },
    {
      name: "bot-private topic",
      chat: { id: 123, type: "private" as const, first_name: "Ada" },
      threadSpec: { scope: "dm" as const, id: 77 },
    },
    {
      name: "regular group",
      chat: { id: -123, type: "group" as const, title: "Reviewers" },
      threadSpec: { scope: "none" as const },
    },
    {
      name: "forum topic without redundant chat metadata",
      chat: { id: -124, type: "supergroup" as const, title: "Reviewers" },
      threadSpec: { scope: "forum" as const, id: 88 },
    },
  ])("stores and retrieves $name thread specs", async ({ chat, threadSpec }) => {
    const threadId = "id" in threadSpec ? threadSpec.id : undefined;
    const pollId = `poll-${threadSpec.scope}-${threadId ?? "base"}`;
    await recordTelegramPollRegistryEntry({
      pollId,
      chat,
      messageId: 44,
      threadSpec,
      question: "Ready?",
      options: ["Yes", "No"],
    });

    await expect(findTelegramPollRegistryEntry({ pollId })).resolves.toEqual(
      expect.objectContaining({
        chat,
        messageId: 44,
        threadSpec,
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
      threadSpec: { scope: "dm" },
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

  it.each([
    {
      name: "invalid chat id",
      chat: { id: "not-a-chat", type: "private", first_name: "Ada" },
      threadSpec: { scope: "dm" },
    },
    {
      name: "old numeric-only shape",
      chat: { id: 123, type: "private", first_name: "Ada" },
      threadSpec: undefined,
      messageThreadId: 77,
    },
    {
      name: "direct messages scope",
      chat: { id: -123, type: "supergroup", title: "Channel replies" },
      threadSpec: { scope: "direct-messages", id: 77 },
    },
    {
      name: "direct messages chat",
      chat: {
        id: -123,
        type: "supergroup",
        title: "Channel replies",
        is_direct_messages: true,
      },
      threadSpec: { scope: "forum", id: 77 },
    },
    {
      name: "forum without id",
      chat: { id: -123, type: "supergroup", title: "Forum" },
      threadSpec: { scope: "forum" },
    },
    {
      name: "none with id",
      chat: { id: -123, type: "group", title: "Reviewers" },
      threadSpec: { scope: "none", id: 77 },
    },
    {
      name: "dm scope on a group",
      chat: { id: -123, type: "group", title: "Reviewers" },
      threadSpec: { scope: "dm", id: 77 },
    },
    {
      name: "forum scope on a private chat",
      chat: { id: 123, type: "private", first_name: "Ada" },
      threadSpec: { scope: "forum", id: 77 },
    },
  ])("rejects malformed stored origin data: $name", async (invalid) => {
    installTelegramStateRuntime((() => ({
      lookup: async () => ({
        pollId: "poll-invalid-chat",
        chat: invalid.chat,
        messageId: 44,
        ...(invalid.threadSpec === undefined ? {} : { threadSpec: invalid.threadSpec }),
        ...(invalid.messageThreadId === undefined
          ? {}
          : { messageThreadId: invalid.messageThreadId }),
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
