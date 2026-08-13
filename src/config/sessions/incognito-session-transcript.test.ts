import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  createSessionEntryWithTranscript,
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

const sessionKey = "agent:main:dashboard:incognito-round-trip";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("incognito transcript access", () => {
  it("round-trips two turns through the normal marker-backed SessionManager", async () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "incognito-turns-")),
    );
    try {
      const created = await createSessionEntryWithTranscript(
        { agentId: "main", sessionKey },
        () => ({
          ok: true as const,
          entry: {
            incognito: true as const,
            sessionId: "incognito-session",
            updatedAt: 1,
          },
        }),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const durableStorePath = path.join(cwd, "sessions.json");
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey,
          storePath: durableStorePath,
        })?.incognito,
      ).toBe(true);
      expect(fs.existsSync(durableStorePath)).toBe(false);

      const target = {
        agentId: "main",
        sessionId: created.entry.sessionId,
        sessionKey,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const firstTurn = SessionManager.open(target, cwd);
      firstTurn.appendMessage({ role: "user", content: "first question", timestamp: 1 });
      firstTurn.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });

      const secondTurn = SessionManager.open(target, cwd);
      secondTurn.appendMessage({ role: "user", content: "second question", timestamp: 3 });
      const messages = secondTurn.buildSessionContext().messages;

      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(messages[0]).toMatchObject({ content: "first question" });
      expect(messages[2]).toMatchObject({ content: "second question" });
    } finally {
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("prunes incognito transcripts in process without publishing a disk archive", async () => {
    const stateDir = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "incognito-maintenance-")),
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const archiveDirectory = path.join(path.dirname(path.dirname(storePath)), "sessions");
    const staleScope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:dashboard:incognito-stale",
      storePath,
    };
    const activeScope = {
      agentId: "main",
      env,
      sessionKey: "agent:main:dashboard:incognito-active",
      storePath,
    };
    const now = Date.now();
    const staleUpdatedAt = now - 366 * 24 * 60 * 60 * 1000;

    try {
      await patchSessionEntryCore(
        staleScope,
        () => ({ sessionId: "incognito-stale-session", updatedAt: staleUpdatedAt }),
        {
          fallbackEntry: { sessionId: "incognito-stale-session", updatedAt: staleUpdatedAt },
          replaceEntry: true,
          skipMaintenance: true,
        },
      );
      await replaceTranscriptEvents({ ...staleScope, sessionId: "incognito-stale-session" }, [
        {
          id: "incognito-stale-event",
          timestamp: new Date(now).toISOString(),
          type: "metadata",
        },
      ]);
      await patchSessionEntryCore(
        activeScope,
        () => ({ sessionId: "incognito-active-session", updatedAt: now + 1 }),
        {
          fallbackEntry: { sessionId: "incognito-active-session", updatedAt: now + 1 },
          replaceEntry: true,
          skipMaintenance: true,
        },
      );

      await patchSessionEntryCore(activeScope, () => ({ model: "gpt-test" }), {
        maintenanceConfig: {
          highWaterBytes: null,
          maxDiskBytes: null,
          maxEntries: 1,
          mode: "enforce",
          modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
          pruneAfterMs: 365 * 24 * 60 * 60 * 1000,
          resetArchiveRetentionMs: null,
        },
      });

      expect(
        listSessionEntriesCore({ agentId: "main", env, storePath }).map(
          (summary) => summary.sessionKey,
        ),
      ).toEqual([activeScope.sessionKey]);
      await expect(
        loadTranscriptEvents({
          ...staleScope,
          sessionId: "incognito-stale-session",
        }),
      ).resolves.toEqual([]);
      expect(fs.existsSync(storePath)).toBe(false);
      expect(fs.existsSync(archiveDirectory)).toBe(false);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
