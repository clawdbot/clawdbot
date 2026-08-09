// Msteams tests cover conversation store state plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it } from "vitest";
import { createMSTeamsConversationStoreState } from "./conversation-store-state.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

function conversationStateKey(conversationId: string): string {
  return crypto.createHash("sha256").update(conversationId).digest("hex");
}

describe("msteams conversation store (plugin state)", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("filters expired SQLite entries while preserving entries without lastSeenAt", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };

    const ref: StoredConversationReference = {
      conversation: { id: "19:active@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1", aadObjectId: "aad1" },
    };
    const sqliteStore = createPluginStateKeyedStoreForTests<StoredConversationReference>(
      "msteams",
      {
        namespace: "conversations",
        maxEntries: 2000,
        env,
      },
    );
    await sqliteStore.register(conversationStateKey("19:active@thread.tacv2"), ref);
    await sqliteStore.register(conversationStateKey("19:old@thread.tacv2"), {
      ...ref,
      conversation: { id: "19:old@thread.tacv2" },
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await sqliteStore.register(conversationStateKey("19:legacy@thread.tacv2"), {
      ...ref,
      conversation: { id: "19:legacy@thread.tacv2" },
    });

    const store = createMSTeamsConversationStoreState({ env, ttlMs: 1_000 });
    const ids = (await store.list()).map((entry) => entry.conversationId).toSorted();
    expect(ids).toEqual(["19:active@thread.tacv2", "19:legacy@thread.tacv2"]);

    expect(await store.get("19:old@thread.tacv2")).toBeNull();
    const legacyConversation = await store.get("19:legacy@thread.tacv2");
    if (!legacyConversation?.conversation) {
      throw new Error("expected migrated legacy Teams conversation payload");
    }
    expect(legacyConversation.conversation.id).toBe("19:legacy@thread.tacv2");

    await store.upsert("19:new@thread.tacv2", {
      ...ref,
      conversation: { id: "19:new@thread.tacv2" },
    });
    const idsAfter = (await store.list()).map((entry) => entry.conversationId).toSorted();
    expect(idsAfter).toEqual([
      "19:active@thread.tacv2",
      "19:legacy@thread.tacv2",
      "19:new@thread.tacv2",
    ]);
    await expect(
      fs.promises.access(path.join(stateDir, "state", "openclaw.sqlite")),
    ).resolves.toBeUndefined();
  });

  it("ignores a stale legacy JSON file at runtime", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const ref: StoredConversationReference = {
      conversation: { id: "conv-current" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com/current",
      user: { id: "current-user" },
    };
    const filePath = path.join(stateDir, "msteams-conversations.json");
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        conversations: {
          "conv-current": {
            ...ref,
            serviceUrl: "https://service.example.com/stale",
            user: { id: "stale-user" },
          },
        },
      })}\n`,
    );
    const sqliteStore = createPluginStateKeyedStoreForTests<StoredConversationReference>(
      "msteams",
      {
        namespace: "conversations",
        maxEntries: 2000,
        env,
      },
    );
    await sqliteStore.register(conversationStateKey("conv-current"), ref);

    const store = createMSTeamsConversationStoreState({ env });
    await expect(store.get("conv-current")).resolves.toEqual(ref);
    await expect(fs.promises.access(filePath)).resolves.toBeUndefined();
  });

  it("hashes external conversation ids before using plugin-state keys", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const longConversationId = `a:${"x".repeat(900)}`;
    const store = createMSTeamsConversationStoreState({ stateDir });

    await store.upsert(longConversationId, {
      conversation: { conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "long-user" },
    });
    await expect(store.get(longConversationId)).resolves.toMatchObject({
      conversation: { id: longConversationId },
      user: { id: "long-user" },
    });
  });

  it("does not let account ids collide with raw Teams conversation id prefixes", async () => {
    await withTempDir("openclaw-msteams-store-", async (stateDir) => {
      const baseStore = createMSTeamsConversationStoreState({ stateDir });

      await baseStore.upsert("19:default@thread.tacv2", {
        conversation: { conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com/default",
        user: { id: "default-user" },
      });

      const accountStore = createMSTeamsConversationStoreState({ stateDir, accountId: "19" });
      await accountStore.upsert("19:account@thread.tacv2", {
        conversation: { conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com/account",
        user: { id: "account-user" },
      });

      await expect(accountStore.findPreferredDmByUserId("default-user")).resolves.toBeNull();
      await expect(accountStore.findPreferredDmByUserId("account-user")).resolves.toMatchObject({
        conversationId: "19:account@thread.tacv2",
        reference: {
          conversation: { id: "19:account@thread.tacv2" },
          user: { id: "account-user" },
        },
      });
      await expect(accountStore.list()).resolves.toEqual([
        expect.objectContaining({ conversationId: "19:account@thread.tacv2" }),
      ]);
    });
  });

  it("keeps legacy unscoped conversation state available to the default account", async () => {
    await withTempDir("openclaw-msteams-store-", async (stateDir) => {
      const baseStore = createMSTeamsConversationStoreState({ stateDir });
      await baseStore.upsert("legacy-conversation", {
        conversation: { id: "legacy-conversation", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com/legacy",
        user: { id: "legacy-user" },
      });

      const defaultStore = createMSTeamsConversationStoreState({ stateDir });
      await expect(defaultStore.get("legacy-conversation")).resolves.toMatchObject({
        conversation: { id: "legacy-conversation" },
        user: { id: "legacy-user" },
      });

      await defaultStore.upsert("legacy-conversation", {
        conversation: { id: "legacy-conversation", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com/updated",
        user: { id: "legacy-user" },
      });
      await expect(baseStore.get("legacy-conversation")).resolves.toMatchObject({
        serviceUrl: "https://service.example.com/updated",
      });
    });
  });

  it("serializes concurrent upserts so sparse activities preserve independent fields", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const store = createMSTeamsConversationStoreState({ stateDir });

    await store.upsert("conv-race", {
      conversation: { id: "conv-race", conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
    });

    await Promise.all([
      store.upsert("conv-race", {
        conversation: { id: "conv-race", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        timezone: "Europe/London",
      }),
      store.upsert("conv-race", {
        conversation: { id: "conv-race", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        user: { id: "u1" },
        tenantId: "tenant-1",
      }),
    ]);

    await expect(store.get("conv-race")).resolves.toMatchObject({
      timezone: "Europe/London",
      tenantId: "tenant-1",
    });
  });

  it("finds account-scoped personal DMs by AAD object id", async () => {
    await withTempDir("openclaw-msteams-store-", async (stateDir) => {
      const defaultStore = createMSTeamsConversationStoreState({ stateDir });
      const secondaryStore = createMSTeamsConversationStoreState({
        stateDir,
        accountId: "secondary",
      });

      await defaultStore.upsert("default-dm", {
        conversation: { id: "default-dm", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://default.example.com",
        user: { id: "default-user", aadObjectId: "aad-shared" },
      });
      await secondaryStore.upsert("secondary-channel", {
        conversation: { id: "secondary-channel", conversationType: "channel" },
        channelId: "msteams",
        serviceUrl: "https://secondary-channel.example.com",
        user: { id: "secondary-channel-user", aadObjectId: "aad-shared" },
      });
      await secondaryStore.upsert("secondary-dm", {
        conversation: { id: "secondary-dm", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://secondary.example.com",
        user: { id: "secondary-user", aadObjectId: "aad-shared" },
      });

      await expect(secondaryStore.findPreferredDmByUserId("aad-shared")).resolves.toMatchObject({
        conversationId: "secondary-dm",
        reference: {
          conversation: { id: "secondary-dm", conversationType: "personal" },
          serviceUrl: "https://secondary.example.com",
          user: { id: "secondary-user", aadObjectId: "aad-shared" },
        },
      });
      await expect(defaultStore.findPreferredDmByUserId("aad-shared")).resolves.toMatchObject({
        conversationId: "default-dm",
        reference: {
          conversation: { id: "default-dm", conversationType: "personal" },
          serviceUrl: "https://default.example.com",
          user: { id: "default-user", aadObjectId: "aad-shared" },
        },
      });
      await expect(defaultStore.list()).resolves.toEqual([
        expect.objectContaining({ conversationId: "default-dm" }),
      ]);
    });
  });

  it("keeps each account's conversation retention quota independent", async () => {
    await withTempDir("openclaw-msteams-store-", async (stateDir) => {
      const defaultStore = createMSTeamsConversationStoreState({ stateDir });
      const busyStore = createMSTeamsConversationStoreState({ stateDir, accountId: "busy" });
      await defaultStore.upsert("default-conversation", {
        conversation: { id: "default-conversation", conversationType: "personal" },
        channelId: "msteams",
        serviceUrl: "https://default.example.com",
        user: { id: "default-user" },
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      });

      for (let index = 0; index <= 1000; index += 1) {
        const id = `busy-${String(index).padStart(4, "0")}`;
        await busyStore.upsert(id, {
          conversation: { id, conversationType: "personal" },
          channelId: "msteams",
          serviceUrl: "https://busy.example.com",
          user: { id: `busy-user-${index}` },
          lastSeenAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
        });
      }

      await expect(defaultStore.get("default-conversation")).resolves.toMatchObject({
        user: { id: "default-user" },
      });
      await expect(busyStore.list()).resolves.toHaveLength(1000);
    });
  });

  it("keeps newest conversations by lastSeenAt at the row cap", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sqliteStore = createPluginStateKeyedStoreForTests<StoredConversationReference>(
      "msteams",
      {
        namespace: "conversations",
        maxEntries: 2000,
        env,
      },
    );
    for (let index = 0; index < 1000; index += 1) {
      const id = `conv-${String(index).padStart(4, "0")}`;
      await sqliteStore.register(conversationStateKey(id), {
        conversation: { id },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        lastSeenAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
      });
    }

    const store = createMSTeamsConversationStoreState({ env });
    await store.upsert("conv-recent", {
      conversation: { id: "conv-recent" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
    });
    const ids = (await store.list()).map((entry) => entry.conversationId);

    expect(ids).toHaveLength(1000);
    expect(ids).toContain("conv-recent");
    expect(ids).not.toContain("conv-0000");
  });

  it("treats timestamp-less conversations as oldest during later cap pruning", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sqliteStore = createPluginStateKeyedStoreForTests<StoredConversationReference>(
      "msteams",
      {
        namespace: "conversations",
        maxEntries: 2000,
        env,
      },
    );
    await sqliteStore.register(conversationStateKey("conv-legacy"), {
      conversation: { id: "conv-legacy" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
    });
    for (let index = 0; index < 999; index += 1) {
      const id = `conv-seen-${String(index).padStart(4, "0")}`;
      await sqliteStore.register(conversationStateKey(id), {
        conversation: { id },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        lastSeenAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
      });
    }

    const store = createMSTeamsConversationStoreState({ env });
    await store.upsert("conv-new", {
      conversation: { id: "conv-new" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
    });
    const ids = (await store.list()).map((entry) => entry.conversationId);

    expect(ids).toHaveLength(1000);
    expect(ids).toContain("conv-new");
    expect(ids).not.toContain("conv-legacy");
  });
});
