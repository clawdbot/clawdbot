import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  deleteSessionEntry,
  getConversationSession,
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "./session-store-runtime.js";

describe("current conversation session binding", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-conversation-"));
    storePath = path.join(tempDir, "sessions.sqlite");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves an exact conversation through session reset and deletion", async () => {
    const sessionKey = "agent:main:reef:group:room";
    const address = {
      agentId: "main",
      storePath,
      channel: "reef",
      accountId: "default",
      kind: "group" as const,
      peerId: "room",
      threadId: "thread-1",
    };
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "before-reset",
        updatedAt: Date.now(),
        chatType: "group",
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "reef",
            accountId: "default",
            to: "group:room",
            threadId: "thread-1",
          },
        }),
      },
    });
    expect(getConversationSession(address)).toEqual({ sessionKey, sessionId: "before-reset" });
    expect(getConversationSession({ ...address, accountId: "other" })).toBeUndefined();
    expect(getConversationSession({ ...address, threadId: "thread-2" })).toBeUndefined();
    await resetSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archivePreviousTranscript: false,
      buildNextEntry: ({ currentEntry }) => ({
        ...currentEntry,
        sessionId: "after-reset",
        updatedAt: Date.now(),
      }),
    });
    expect(getConversationSession(address)).toEqual({ sessionKey, sessionId: "after-reset" });
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: { sessionId: "without-route", updatedAt: Date.now() },
    });
    expect(getConversationSession(address)).toBeUndefined();
    await deleteSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(getConversationSession(address)).toBeUndefined();
  });

  it("does not let a later parent turn replace an existing thread owner", async () => {
    const parentKey = "agent:main:reef:group:room";
    const threadKey = `${parentKey}:thread:first`;
    const address = {
      agentId: "main",
      storePath,
      channel: "reef",
      accountId: "default",
      kind: "group" as const,
      peerId: "room",
      threadId: "first",
    };
    for (const [sessionKey, sessionId, threadId, updatedAt] of [
      [parentKey, "parent", "first", 100],
      [threadKey, "thread", "first", 200],
      [parentKey, "parent", "second", 300],
    ] as const) {
      await upsertSessionEntry({
        agentId: "main",
        sessionKey,
        storePath,
        entry: {
          sessionId,
          updatedAt,
          chatType: "group",
          delivery: normalizeSessionDeliveryState({
            context: { channel: "reef", accountId: "default", to: "group:room", threadId },
          }),
        },
      });
    }
    expect(getConversationSession(address)).toEqual({ sessionKey: threadKey, sessionId: "thread" });
    await deleteSessionEntry({ agentId: "main", sessionKey: threadKey, storePath });
    expect(getConversationSession(address)).toBeUndefined();
  });
});
