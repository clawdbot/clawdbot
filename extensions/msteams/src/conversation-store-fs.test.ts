import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import type { StoredConversationReference } from "./conversation-store.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

describe("msteams conversation store (fs-only)", () => {
  beforeEach(() => {
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("filters and prunes expired entries while preserving legacy entries without lastSeenAt", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-store-"));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    };

    const store = createMSTeamsConversationStoreFs({ env, ttlMs: 1_000 });

    const ref: StoredConversationReference = {
      conversation: { id: "19:active@thread.tacv2" },
      channelId: "msteams",
      serviceUrl: "https://service.example.com",
      user: { id: "u1", aadObjectId: "aad1" },
    };

    await store.upsert("19:active@thread.tacv2", ref);

    const filePath = path.join(stateDir, "msteams-conversations.json");
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const json = JSON.parse(raw) as {
      version: number;
      conversations: Record<string, StoredConversationReference>;
    };

    json.conversations["19:old@thread.tacv2"] = {
      ...ref,
      conversation: { id: "19:old@thread.tacv2" },
      lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    };

    json.conversations["19:legacy@thread.tacv2"] = {
      ...ref,
      conversation: { id: "19:legacy@thread.tacv2" },
    };

    await fs.promises.writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`);

    const list = await store.list();
    const ids = list.map((entry) => entry.conversationId).toSorted();
    expect(ids).toEqual(["19:active@thread.tacv2", "19:legacy@thread.tacv2"]);

    expect(await store.get("19:old@thread.tacv2")).toBeNull();
    const legacyConversation = await store.get("19:legacy@thread.tacv2");
    if (!legacyConversation) {
      throw new Error("expected migrated legacy Teams conversation");
    }
    if (!legacyConversation.conversation) {
      throw new Error("expected migrated legacy Teams conversation payload");
    }
    expect(legacyConversation.conversation.id).toBe("19:legacy@thread.tacv2");

    await store.upsert("19:new@thread.tacv2", {
      ...ref,
      conversation: { id: "19:new@thread.tacv2" },
    });

    const rawAfter = await fs.promises.readFile(filePath, "utf-8");
    const jsonAfter = JSON.parse(rawAfter) as typeof json;
    expect(Object.keys(jsonAfter.conversations).toSorted()).toEqual([
      "19:active@thread.tacv2",
      "19:legacy@thread.tacv2",
      "19:new@thread.tacv2",
    ]);
  });
});
