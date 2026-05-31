import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
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

  it("filters and prunes expired entries while preserving legacy entries without lastSeenAt", async () => {
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
    const filePath = path.join(stateDir, "msteams-conversations.json");
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify(
        {
          version: 1,
          conversations: {
            "19:active@thread.tacv2": ref,
            "19:old@thread.tacv2": {
              ...ref,
              conversation: { id: "19:old@thread.tacv2" },
              lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
            },
            "19:legacy@thread.tacv2": {
              ...ref,
              conversation: { id: "19:legacy@thread.tacv2" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = createMSTeamsConversationStoreState({ env, ttlMs: 1_000 });
    const ids = (await store.list()).map((entry) => entry.conversationId).toSorted();
    expect(ids).toEqual(["19:active@thread.tacv2", "19:legacy@thread.tacv2"]);
    await expect(fs.promises.access(filePath)).rejects.toThrow();

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

  it("does not let a stale legacy JSON file overwrite existing SQLite rows", async () => {
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
  });

  it("hashes external conversation ids before using plugin-state keys", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const longConversationId = `a:${"x".repeat(900)}`;
    const filePath = path.join(stateDir, "msteams-conversations.json");
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        conversations: {
          [longConversationId]: {
            channelId: "msteams",
            serviceUrl: "https://service.example.com",
            user: { id: "long-user" },
          } satisfies StoredConversationReference,
        },
      })}\n`,
    );

    const store = createMSTeamsConversationStoreState({ stateDir });

    await expect(store.get(longConversationId)).resolves.toMatchObject({
      conversation: { id: longConversationId },
      user: { id: "long-user" },
    });
    await store.upsert(`${longConversationId}-new`, {
      conversation: { conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "long-user-new" },
    });
    await expect(store.get(`${longConversationId}-new`)).resolves.toMatchObject({
      conversation: { id: `${longConversationId}-new` },
      user: { id: "long-user-new" },
    });
  });

  it("serializes concurrent upserts so sparse activities do not drop preserved fields", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const store = createMSTeamsConversationStoreState({ stateDir });

    await store.upsert("conv-race", {
      conversation: { id: "conv-race", conversationType: "personal" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1" },
      graphChatId: "19:resolved@unq.gbl.spaces",
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
      graphChatId: "19:resolved@unq.gbl.spaces",
      timezone: "Europe/London",
      tenantId: "tenant-1",
    });
  });

  it("keeps newest legacy conversations by lastSeenAt at the row cap", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const filePath = path.join(stateDir, "msteams-conversations.json");
    const conversations: Record<string, StoredConversationReference> = {
      "conv-recent": {
        conversation: { id: "conv-recent" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        lastSeenAt: "2026-03-25T20:00:00.000Z",
      },
    };
    for (let index = 0; index < 1000; index += 1) {
      const id = `conv-${String(index).padStart(4, "0")}`;
      conversations[id] = {
        conversation: { id },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        lastSeenAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
      };
    }
    await fs.promises.writeFile(filePath, `${JSON.stringify({ version: 1, conversations })}\n`);

    const store = createMSTeamsConversationStoreState({ stateDir });
    const ids = (await store.list()).map((entry) => entry.conversationId);

    expect(ids).toHaveLength(1000);
    expect(ids).toContain("conv-recent");
    expect(ids).not.toContain("conv-0000");
  });

  it("treats timestamp-less legacy conversations as oldest during later cap pruning", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));
    const filePath = path.join(stateDir, "msteams-conversations.json");
    const conversations: Record<string, StoredConversationReference> = {
      "conv-legacy": {
        conversation: { id: "conv-legacy" },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
      },
    };
    for (let index = 0; index < 999; index += 1) {
      const id = `conv-seen-${String(index).padStart(4, "0")}`;
      conversations[id] = {
        conversation: { id },
        channelId: "msteams",
        serviceUrl: "https://service.example.com",
        lastSeenAt: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
      };
    }
    await fs.promises.writeFile(filePath, `${JSON.stringify({ version: 1, conversations })}\n`);

    const store = createMSTeamsConversationStoreState({ stateDir });
    await store.list();
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
