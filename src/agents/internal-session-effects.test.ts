import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  listSessionEntries,
  loadExactSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  prepareInternalSessionEffectsSession,
  removeInternalSessionEffectsSession,
} from "./internal-session-effects.js";

describe("internal session effects", () => {
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
      expect(loadExactSessionEntry(target)?.entry.sessionId).toBe(target.sessionId);
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
