// Covers SQLite-backed CLI session transcript loading boundaries.
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cliBackendLog } from "./log.js";
import {
  hasCliSessionTranscript,
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
  loadCliSessionReseedMessages,
} from "./session-history.js";

const MAX_CLI_SESSION_HISTORY_FILE_BYTES = 5 * 1024 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectMessageFields(value: unknown, expected: { role: string; content?: unknown }) {
  const message = requireRecord(value, "message");
  expect(message.role).toBe(expected.role);
  if ("content" in expected) {
    expect(message.content).toEqual(expected.content);
  }
}

async function withCliSessionState<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, run);
}

describe("SQLite CLI session history", () => {
  it("loads branched history from markers used by CLI resumes", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionId = "session-sqlite-branch";
    const sessionKey = "agent:main:main";
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionFiles = [
      formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
      formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId,
        storePath: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      }),
    ];

    await withCliSessionState(stateDir, async () => {
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "active root" },
        },
        {
          type: "message",
          id: "side-entry",
          parentId: "root",
          message: { role: "assistant", content: "side history" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-entry",
          targetId: "root",
        },
        {
          type: "message",
          id: "active-tail",
          parentId: "root",
          message: { role: "assistant", content: "active history" },
        },
      ]);

      for (const sessionFile of sessionFiles) {
        await expect(
          hasCliSessionTranscript({
            sessionId,
            sessionFile,
            sessionKey,
            agentId: "main",
          }),
        ).resolves.toBe(true);
        const history = await loadCliSessionHistoryMessages({
          sessionId,
          sessionFile,
          sessionKey,
          agentId: "main",
        });
        expect(history).toHaveLength(2);
        expectMessageFields(history[0], { role: "user", content: "active root" });
        expectMessageFields(history[1], {
          role: "assistant",
          content: [{ type: "text", text: "active history" }],
        });
      }
    });
  });

  it("excludes an already-persisted current turn from history consumers", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionId = "session-sqlite-current-turn";
    const sessionKey = "agent:main:main";
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionFile = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const excludeMessageIdempotencyKey = "cli-user:current-turn";

    await withCliSessionState(stateDir, async () => {
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        },
        {
          type: "message",
          id: "msg-prior",
          parentId: null,
          message: { role: "user", content: "prior ask", idempotencyKey: "cli-user:prior" },
        },
        {
          type: "compaction",
          id: "compaction-1",
          parentId: "msg-prior",
          timestamp: new Date(2).toISOString(),
          summary: "prior compacted context",
          firstKeptEntryId: "msg-prior",
          tokensBefore: 100,
        },
        {
          type: "message",
          id: "msg-answer",
          parentId: "compaction-1",
          message: {
            role: "assistant",
            content: "prior answer",
            idempotencyKey: "cli-assistant:prior",
          },
        },
        {
          type: "message",
          id: "msg-current",
          parentId: "msg-answer",
          message: {
            role: "user",
            content: "current ask",
            idempotencyKey: excludeMessageIdempotencyKey,
          },
        },
      ]);

      const controlHistory = await loadCliSessionHistoryMessages({
        sessionId,
        sessionFile,
        sessionKey,
        agentId: "main",
      });
      expect(controlHistory).toHaveLength(3);
      expectMessageFields(controlHistory.at(-1), { role: "user", content: "current ask" });

      const transcriptParams = {
        sessionId,
        sessionFile,
        sessionKey,
        agentId: "main",
        excludeMessageIdempotencyKey,
      };
      const history = await loadCliSessionHistoryMessages(transcriptParams);
      expect(history).toHaveLength(2);
      expectMessageFields(history[0], { role: "user", content: "prior ask" });
      expectMessageFields(history[1], {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
      });

      const contextEngineHistory = await loadCliSessionContextEngineMessages(transcriptParams);
      expect(contextEngineHistory).toHaveLength(2);
      expect(contextEngineHistory[0]).toMatchObject({
        role: "compactionSummary",
        summary: "prior compacted context",
      });
      expectMessageFields(contextEngineHistory[1], {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
      });

      const reseedHistory = await loadCliSessionReseedMessages(transcriptParams);
      expect(reseedHistory).toHaveLength(2);
      expect(reseedHistory[0]).toMatchObject({
        role: "compactionSummary",
        summary: "prior compacted context",
      });
      expectMessageFields(reseedHistory[1], {
        role: "assistant",
        content: [{ type: "text", text: "prior answer" }],
      });
    });
  });

  it("loads only a bounded tail from oversized transcripts", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionId = "session-sqlite-oversized";
    const sessionKey = "agent:main:main";
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const sqliteQueries = await import("../../infra/kysely-sync.js");
    const iterateSpy = vi.spyOn(sqliteQueries, "iterateSqliteQuerySync");
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);

    try {
      await withCliSessionState(stateDir, async () => {
        await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
          {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: sessionId,
            timestamp: new Date(0).toISOString(),
            cwd: stateDir,
          },
          {
            type: "message",
            id: "msg-0",
            parentId: null,
            message: {
              role: "user",
              content: "x".repeat(MAX_CLI_SESSION_HISTORY_FILE_BYTES),
            },
          },
          {
            type: "message",
            id: "msg-1",
            parentId: "msg-0",
            message: { role: "user", content: "tail history" },
          },
        ]);

        const history = await loadCliSessionHistoryMessages({
          sessionId,
          sessionFile,
          sessionKey,
          agentId: "main",
        });
        expect(history).toHaveLength(1);
        expectMessageFields(history[0], { role: "user", content: "tail history" });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cli session history truncated to last"),
        );
        const tailSelectionSql = iterateSpy.mock.calls
          .map(([, query]) => query.compile().sql)
          .find((sql) => sql.includes('from "transcript_events"'));
        expect(tailSelectionSql).toBeDefined();
        expect(tailSelectionSql).not.toMatch(/select "event_json"/);
      });
    } finally {
      iterateSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("honors an explicit session store passed to the CLI runner", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const customStoreDir = tempDirs.make("openclaw-cli-store-");
    const sessionId = "session-sqlite-custom-store";
    const sessionKey = "agent:main:main";
    const storePath = path.join(customStoreDir, "sessions.json");
    const sessionFile = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });

    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: stateDir,
      },
      {
        type: "message",
        id: "msg-0",
        parentId: null,
        message: { role: "user", content: "custom SQLite history" },
      },
    ]);

    await withCliSessionState(stateDir, async () => {
      const history = await loadCliSessionHistoryMessages({
        sessionId,
        sessionFile,
        sessionKey,
        agentId: "main",
        storePath,
      });
      expect(history).toHaveLength(1);
      expectMessageFields(history[0], { role: "user", content: "custom SQLite history" });
    });
  });

  it("uses the current explicit store after the state directory is relocated", async () => {
    const oldStateDir = tempDirs.make("openclaw-cli-old-state-");
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionId = "session-sqlite-relocated-store";
    const sessionKey = "agent:main:main";
    const oldStorePath = path.join(oldStateDir, "agents", "main", "sessions", "sessions.json");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath: oldStorePath,
    });

    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: stateDir,
      },
      {
        type: "message",
        id: "msg-0",
        parentId: null,
        message: { role: "user", content: "relocated SQLite history" },
      },
    ]);

    await withCliSessionState(stateDir, async () => {
      await expect(
        hasCliSessionTranscript({
          sessionId,
          sessionFile,
          sessionKey,
          agentId: "main",
          storePath,
        }),
      ).resolves.toBe(true);
      const history = await loadCliSessionHistoryMessages({
        sessionId,
        sessionFile,
        sessionKey,
        agentId: "main",
        storePath,
      });
      expect(history).toHaveLength(1);
      expectMessageFields(history[0], { role: "user", content: "relocated SQLite history" });
    });
  });

  it("checks SQLite transcript existence without computing full transcript stats", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionId = "session-sqlite-exists";
    const sessionKey = "agent:main:main";
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionFile = formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath });
    const accessor = await import("../../config/sessions/session-accessor.js");
    const statsSpy = vi.spyOn(accessor, "readTranscriptStatsSync").mockImplementation(() => {
      throw new Error("full transcript stats should not be read");
    });

    try {
      await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        },
      ]);

      await withCliSessionState(stateDir, async () => {
        await expect(
          hasCliSessionTranscript({ sessionId, sessionFile, sessionKey, agentId: "main" }),
        ).resolves.toBe(true);
      });
      expect(statsSpy).not.toHaveBeenCalled();
    } finally {
      statsSpy.mockRestore();
    }
  });

  it("rejects markers outside the configured session identity", async () => {
    const stateDir = tempDirs.make("openclaw-cli-state-");
    const sessionId = "session-sqlite-guard";
    const sessionKey = "agent:main:main";
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");

    await withCliSessionState(stateDir, async () => {
      const transcript = [
        {
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: sessionId,
          timestamp: new Date(0).toISOString(),
          cwd: stateDir,
        },
        {
          type: "message",
          id: "msg-0",
          parentId: null,
          message: { role: "user", content: "guarded history" },
        },
      ];
      await replaceTranscriptEvents(
        { agentId: "main", sessionId, sessionKey, storePath },
        transcript,
      );
      const invalidMarkers = [
        formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "other-session",
          storePath,
        }),
        formatSqliteSessionFileMarker({ agentId: "worker", sessionId, storePath }),
      ];
      for (const sessionFile of invalidMarkers) {
        await expect(
          hasCliSessionTranscript({ sessionId, sessionFile, sessionKey, agentId: "main" }),
        ).resolves.toBe(false);
        await expect(
          loadCliSessionHistoryMessages({
            sessionId,
            sessionFile,
            sessionKey,
            agentId: "main",
          }),
        ).resolves.toStrictEqual([]);
      }
    });
  });
});
