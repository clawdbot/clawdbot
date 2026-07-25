import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  listSessionEntries,
  loadExactSessionEntry,
  loadTranscriptEvents,
  persistSessionResetLifecycle,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  prepareInternalSessionEffectsSession,
  removeInternalSessionEffectsSession,
  resolveInternalSessionEffectsTarget,
} from "./internal-session-effects.js";

describe("internal session effects", () => {
  it("keeps hidden effects from an incognito run in the sentinel store", async () => {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    try {
      const target = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "incognito-run",
        storePath,
      });

      expect(target.sessionKey).toMatch(
        /^agent:main:internal-session-effects:incognito-incognito-run-/,
      );
      expect(loadExactSessionEntry(target)?.entry.incognito).toBe(true);
    } finally {
      closeOpenClawAgentDatabasesForTest();
    }
  });

  it("does not archive an incognito internal-effects transcript during rotation", async () => {
    await withTempDir({ prefix: "openclaw-incognito-internal-rotation-" }, async (dir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: dir }, async () => {
        const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
        try {
          const target = await prepareInternalSessionEffectsSession({
            agentId: "main",
            runId: "rotation",
            storePath,
          });
          const previousTranscript = path.join(dir, "private-internal.jsonl");
          await fs.writeFile(
            previousTranscript,
            `${JSON.stringify({
              type: "session",
              version: 3,
              id: target.sessionId,
              timestamp: new Date().toISOString(),
            })}\n`,
            "utf8",
          );
          const previousEntry = await upsertSessionEntry(target, {
            ...target.sessionEntry,
            sessionFile: previousTranscript,
          });
          if (!previousEntry) {
            throw new Error("failed to seed incognito internal-effects entry");
          }
          const nextTranscript = path.join(dir, "next-internal.jsonl");

          await persistSessionResetLifecycle({
            agentId: "main",
            cleanupPreviousTranscript: true,
            nextEntry: {
              ...previousEntry,
              sessionFile: nextTranscript,
              sessionId: "internal-session-effects-rotated",
              updatedAt: Date.now(),
            },
            nextSessionFile: nextTranscript,
            previousEntry,
            previousSessionId: target.sessionId,
            sessionKey: target.sessionKey,
            storePath,
          });

          expect(await fs.readdir(dir)).toContain("private-internal.jsonl");
          expect((await fs.readdir(dir)).some((name) => name.includes(".reset."))).toBe(false);
        } finally {
          closeOpenClawAgentDatabasesForTest();
        }
      });
    });
  });

  it("creates a hidden deterministic SQLite session", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const target = await prepareInternalSessionEffectsSession({
        agentId: "main",
        cwd: dir,
        runId: "run/with space",
        storePath,
      });

      expect(target.sessionKey).toMatch(/^agent:main:internal-session-effects:run_with_space-/);
      expect(target.sessionId).toMatch(/^internal-session-effects-run_with_space-/);
      expect(loadExactSessionEntry(target)?.entry).toMatchObject({
        sessionId: target.sessionId,
        createdVia: "internal",
        createdActor: { type: "system" },
        delivery: { kind: "internal" },
        createdAt: expect.any(Number),
      });
      expect(listSessionEntries({ storePath })).toEqual([]);
      await expect(loadTranscriptEvents(target)).resolves.toEqual([
        expect.objectContaining({ id: target.sessionId, type: "session" }),
      ]);

      const reopened = await prepareInternalSessionEffectsSession({
        agentId: "main",
        cwd: dir,
        runId: "run/with space",
        storePath,
      });
      expect(reopened).toEqual(target);
    });
  });

  it("escapes the reserved prefix for a durable internal-effects run id", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      const target = resolveInternalSessionEffectsTarget({
        agentId: "main",
        runId: "incognito-not-private",
        storePath: path.join(dir, "sessions.json"),
      });

      expect(target.sessionKey).toMatch(
        /^agent:main:internal-session-effects:legacy-incognito-not-private-/,
      );
    });
  });

  it("forks visible SQLite history into the hidden session", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const source = {
        agentId: "main",
        sessionId: "visible-session",
        sessionKey: "agent:main:main",
        storePath,
      };
      await upsertSessionEntry(source, { sessionId: source.sessionId, updatedAt: 1 });
      await appendTranscriptMessage(source, {
        cwd: dir,
        message: { content: "stored", role: "assistant", timestamp: 2 },
      });

      const target = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "run-copy",
        source,
        storePath,
      });
      const events = await loadTranscriptEvents(target);

      expect(events[0]).toMatchObject({ id: target.sessionId, type: "session" });
      expect(events).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "stored", role: "assistant" }),
          type: "message",
        }),
      );
      expect(listSessionEntries({ storePath })).toEqual([
        expect.objectContaining({ sessionKey: source.sessionKey }),
      ]);
    });
  });

  it("hard-deletes the hidden entry and transcript rows", async () => {
    await withTempDir({ prefix: "openclaw-internal-session-effects-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const target = await prepareInternalSessionEffectsSession({
        agentId: "main",
        runId: "run-cleanup",
        storePath,
      });
      await appendTranscriptMessage(target, {
        message: { content: "private", role: "assistant", timestamp: 2 },
      });

      await removeInternalSessionEffectsSession(target);

      expect(loadExactSessionEntry(target)).toBeUndefined();
      await expect(loadTranscriptEvents(target)).resolves.toEqual([]);
    });
  });
});
