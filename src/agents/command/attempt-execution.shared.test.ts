// Covers guarded session-store persistence.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { persistAgentSession } from "./attempt-execution.shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("persistAgentSession", () => {
  const sessionKey = "agent:main:main";

  it("clears stale local entries when guarded persistence sees no persisted entry", async () => {
    const dir = tempDirs.make("openclaw-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const sessionStore = {
        [sessionKey]: {
          sessionId: "stale",
          updatedAt: 1,
        },
      };

      // A guarded write can decline persistence after rereading disk; local
      // memory must be cleared too so later turns do not reuse stale entries.
      const persisted = await persistAgentSession({
        sessionStore,
        sessionKey,
        storePath,
        initialEntry: sessionStore[sessionKey],
        entry: {
          sessionId: "stale",
          updatedAt: 2,
        },
        shouldPersist: (entry) => Boolean(entry),
      });

      expect(persisted).toBeUndefined();
      expect(sessionStore[sessionKey]).toBeUndefined();
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it.each([
    {
      name: "rename and unpin",
      current: { label: "Renamed", pinnedAt: undefined },
      expected: { label: "Renamed", pinnedAt: undefined },
    },
    {
      name: "label clear and pin",
      current: { label: undefined, pinnedAt: 300 },
      expected: { label: undefined, pinnedAt: 300 },
    },
  ])("preserves a concurrent $name", async ({ current, expected }) => {
    const dir = tempDirs.make("openclaw-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const staleEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        label: "Old label",
        pinnedAt: 200,
      };
      const currentEntry: SessionEntry = {
        ...staleEntry,
        ...current,
        updatedAt: 400,
      };
      if (current.label === undefined) {
        delete currentEntry.label;
      }
      if (current.pinnedAt === undefined) {
        delete currentEntry.pinnedAt;
      }
      await replaceSessionEntry({ sessionKey, storePath }, currentEntry);
      const sessionStore = { [sessionKey]: staleEntry };

      const persisted = await persistAgentSession({
        sessionStore,
        sessionKey,
        storePath,
        initialEntry: staleEntry,
        entry: {
          ...staleEntry,
          model: "gpt-5.5",
          updatedAt: 250,
        },
      });

      expect(persisted).toMatchObject({ sessionId: "session-1", model: "gpt-5.5" });
      expect(persisted?.label).toBe(expected.label);
      expect(persisted?.pinnedAt).toBe(expected.pinnedAt);
      expect(persisted?.updatedAt).toBeGreaterThanOrEqual(currentEntry.updatedAt);
      expect(sessionStore[sessionKey]).toEqual(persisted);
      expect(loadSessionEntry({ sessionKey, storePath, readConsistency: "latest" })).toEqual(
        persisted,
      );
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("does not restore policy fields revoked during an active turn", async () => {
    const dir = tempDirs.make("openclaw-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const initialEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 100,
        model: "gpt-5.4",
        elevatedLevel: "full",
        inheritedToolAllow: ["exec"],
        sendPolicy: "allow",
      };
      const currentEntry: SessionEntry = {
        sessionId: "session-1",
        updatedAt: 400,
        model: "gpt-5.4",
        sendPolicy: "deny",
      };
      await replaceSessionEntry({ sessionKey, storePath }, currentEntry);
      const sessionStore = { [sessionKey]: initialEntry };

      const persisted = await persistAgentSession({
        sessionStore,
        sessionKey,
        storePath,
        initialEntry,
        entry: {
          ...initialEntry,
          model: "gpt-5.5",
          updatedAt: 250,
        },
      });

      expect(persisted).toMatchObject({
        sessionId: "session-1",
        model: "gpt-5.5",
        sendPolicy: "deny",
        updatedAt: 400,
      });
      expect(persisted?.elevatedLevel).toBeUndefined();
      expect(persisted?.inheritedToolAllow).toBeUndefined();
      expect(loadSessionEntry({ sessionKey, storePath, readConsistency: "latest" })).toEqual(
        persisted,
      );
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("does not recreate a deleted persisted entry from stale local memory", async () => {
    const dir = tempDirs.make("openclaw-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const staleEntry: SessionEntry = {
        sessionId: "deleted-session",
        updatedAt: 1,
      };
      const sessionStore = { [sessionKey]: staleEntry };

      const persisted = await persistAgentSession({
        sessionStore,
        sessionKey,
        storePath,
        initialEntry: staleEntry,
        entry: {
          sessionId: "deleted-session",
          updatedAt: 2,
        },
      });

      expect(persisted).toBeUndefined();
      expect(sessionStore[sessionKey]).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey, storePath, readConsistency: "latest" }),
      ).toBeUndefined();
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("keeps rejecting repeated stale writes after clearing local memory", async () => {
    const dir = tempDirs.make("openclaw-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const staleEntry: SessionEntry = {
        sessionId: "deleted-session",
        updatedAt: 1,
      };
      const sessionStore = { [sessionKey]: staleEntry };

      const first = await persistAgentSession({
        sessionStore,
        sessionKey,
        storePath,
        initialEntry: staleEntry,
        entry: staleEntry,
      });
      const second = await persistAgentSession({
        sessionStore,
        sessionKey,
        storePath,
        initialEntry: staleEntry,
        entry: {
          ...staleEntry,
          updatedAt: 2,
        },
      });

      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
      expect(sessionStore[sessionKey]).toBeUndefined();
      expect(
        loadSessionEntry({ sessionKey, storePath, readConsistency: "latest" }),
      ).toBeUndefined();
    } finally {
      clearSessionStoreCacheForTest();
    }
  });

  it("allows an explicit create-on-missing persistence predicate", async () => {
    const dir = tempDirs.make("openclaw-session-store-");
    try {
      const storePath = path.join(dir, "sessions.json");
      const sessionStore: Record<string, SessionEntry> = {};
      const entry: SessionEntry = {
        sessionId: "created-session",
        updatedAt: 1,
      };

      const persisted = await persistAgentSession({
        sessionStore,
        sessionKey,
        storePath,
        initialEntry: entry,
        entry,
        shouldPersist: (existing) => existing === undefined,
      });

      expect(persisted?.sessionId).toBe("created-session");
      expect(sessionStore[sessionKey]?.sessionId).toBe("created-session");
    } finally {
      clearSessionStoreCacheForTest();
    }
  });
});
