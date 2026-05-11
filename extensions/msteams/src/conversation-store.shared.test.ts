import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { createMSTeamsConversationStoreMemory } from "./conversation-store-memory.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

type StoreFactory = {
  name: string;
  createStore: () => Promise<MSTeamsConversationStore>;
};

const storeFactories: StoreFactory[] = [
  {
    name: "fs",
    createStore: async () => {
      const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
      return createMSTeamsConversationStoreFs({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        ttlMs: 60_000,
      });
    },
  },
  {
    name: "memory",
    createStore: async () => createMSTeamsConversationStoreMemory(),
  },
];

describe.each(storeFactories)("msteams conversation store ($name)", ({ createStore }) => {
  beforeEach(() => {
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("normalizes conversation ids consistently", async () => {
    const store = await createStore();

    await store.upsert("conv-norm;messageid=123", {
      conversation: { id: "conv-norm" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    const normalized = await store.get("conv-norm");
    expect(normalized).toEqual({
      conversation: { id: "conv-norm" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
      lastSeenAt: normalized?.lastSeenAt,
    });
    expect(typeof normalized?.lastSeenAt).toBe("string");
    await expect(store.remove("conv-norm")).resolves.toBe(true);
    await expect(store.get("conv-norm;messageid=123")).resolves.toBeNull();
  });

  it("upserts, lists, removes, and resolves users by both AAD and Bot Framework ids", async () => {
    const store = await createStore();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-25T20:00:00.000Z"));
      await store.upsert("conv-a", {
        conversation: { id: "conv-a" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
      });

      vi.setSystemTime(new Date("2026-03-25T20:00:30.000Z"));
      await store.upsert("conv-b", {
        conversation: { id: "conv-b" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
      });

      await expect(store.get("conv-a")).resolves.toEqual({
        conversation: { id: "conv-a" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      });

      await expect(store.list()).resolves.toEqual([
        {
          conversationId: "conv-a",
          reference: {
            conversation: { id: "conv-a" },
            channelId: "msteams",
            serviceUrl: "https://service.example.com",
            user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
            lastSeenAt: "2026-03-25T20:00:00.000Z",
          },
        },
        {
          conversationId: "conv-b",
          reference: {
            conversation: { id: "conv-b" },
            channelId: "msteams",
            serviceUrl: "https://service.example.com",
            user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
            lastSeenAt: "2026-03-25T20:00:30.000Z",
          },
        },
      ]);

      await expect(store.findPreferredDmByUserId("  aad-b  ")).resolves.toEqual({
        conversationId: "conv-b",
        reference: {
          conversation: { id: "conv-b" },
          channelId: "msteams",
          serviceUrl: "https://service.example.com",
          user: { id: "user-b", aadObjectId: "aad-b", name: "Bob" },
          lastSeenAt: "2026-03-25T20:00:30.000Z",
        },
      });
      await expect(store.findPreferredDmByUserId("user-a")).resolves.toEqual({
        conversationId: "conv-a",
        reference: {
          conversation: { id: "conv-a" },
          channelId: "msteams",
          serviceUrl: "https://service.example.com",
          user: { id: "user-a", aadObjectId: "aad-a", name: "Alice" },
          lastSeenAt: "2026-03-25T20:00:00.000Z",
        },
      });
      await expect(store.findByUserId("user-a")).resolves.toEqual(
        await store.findPreferredDmByUserId("user-a"),
      );
      await expect(store.findPreferredDmByUserId("   ")).resolves.toBeNull();

      await expect(store.remove("conv-a")).resolves.toBe(true);
      await expect(store.get("conv-a")).resolves.toBeNull();
      await expect(store.remove("missing")).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves existing timezone when upsert omits timezone", async () => {
    const store = await createStore();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-25T20:00:00.000Z"));
      await store.upsert("conv-tz", {
        conversation: { id: "conv-tz" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        timezone: "Europe/London",
      });

      vi.setSystemTime(new Date("2026-03-25T20:01:00.000Z"));
      await store.upsert("conv-tz", {
        conversation: { id: "conv-tz" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
      });

      await expect(store.get("conv-tz")).resolves.toEqual({
        conversation: { id: "conv-tz" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        timezone: "Europe/London",
        lastSeenAt: "2026-03-25T20:01:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves graphChatId across upserts that omit it", async () => {
    const store = await createStore();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-25T20:00:00.000Z"));
      await store.upsert("conv-graph", {
        conversation: { id: "conv-graph", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        graphChatId: "19:resolved-chat-id@unq.gbl.spaces",
      });

      vi.setSystemTime(new Date("2026-03-25T20:01:00.000Z"));
      // Second upsert without graphChatId (normal activity-based upsert)
      await store.upsert("conv-graph", {
        conversation: { id: "conv-graph", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
      });

      await expect(store.get("conv-graph")).resolves.toEqual({
        conversation: { id: "conv-graph", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        graphChatId: "19:resolved-chat-id@unq.gbl.spaces",
        lastSeenAt: "2026-03-25T20:01:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers the freshest personal conversation for repeated upserts of the same user", async () => {
    const store = await createStore();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-25T20:00:00.000Z"));
      await store.upsert("dm-old", {
        conversation: { id: "dm-old", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-shared-old", aadObjectId: "aad-shared", name: "Old DM" },
      });

      vi.setSystemTime(new Date("2026-03-25T20:30:00.000Z"));
      await store.upsert("group-shared", {
        conversation: { id: "group-shared", conversationType: "groupChat" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-shared-group", aadObjectId: "aad-shared", name: "Group" },
      });

      vi.setSystemTime(new Date("2026-03-25T21:00:00.000Z"));
      await store.upsert("dm-new", {
        conversation: { id: "dm-new", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "user-shared-new", aadObjectId: "aad-shared", name: "New DM" },
      });

      await expect(store.findPreferredDmByUserId("aad-shared")).resolves.toEqual({
        conversationId: "dm-new",
        reference: {
          conversation: { id: "dm-new", conversationType: "personal" },
          channelId: "msteams",
          serviceUrl: "https://service.example.com",
          user: { id: "user-shared-new", aadObjectId: "aad-shared", name: "New DM" },
          lastSeenAt: "2026-03-25T21:00:00.000Z",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
