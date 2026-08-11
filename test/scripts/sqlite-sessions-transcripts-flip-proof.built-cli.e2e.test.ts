// Built-CLI SQLite flip proof requires dist entrypoints before running the gateway lifecycle.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../../src/config/sessions/archive-compression.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../src/config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../src/config/sessions/session-sqlite-target.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { closeOpenClawAgentDatabasesForTest } from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import { createOpenClawTestInstance } from "../helpers/openclaw-test-instance.js";
import { assertSqliteFlipProofCore } from "../helpers/sqlite-sessions-transcripts-flip-proof-assertions.ts";
import { runSqliteSessionsTranscriptsFlipProof } from "../helpers/sqlite-sessions-transcripts-flip-proof.ts";

describe("SQLite sessions/transcripts flip built CLI proof", () => {
  it("proves the lifecycle through the built gateway CLI entrypoint", async () => {
    const report = await runSqliteSessionsTranscriptsFlipProof({ requireBuiltCli: true });

    expect(report.gatewayEntrypoint).toEqual(
      expect.arrayContaining([expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u)]),
    );
    assertSqliteFlipProofCore(report);
  }, 420_000);

  it("uses the packaged archive worker when deleting a transcript", async () => {
    const inst = await createOpenClawTestInstance({
      name: `sqlite-archive-responsive-${randomUUID()}`,
      startTimeoutMs: 90_000,
      stopTimeoutMs: 5_000,
    });
    inst.state.applyEnv();
    const sessionId = "sqlite-built-archive-worker";
    const sessionKey = "agent:main:dashboard:sqlite-built-archive-worker";
    const storePath = path.join(inst.stateDir, "agents", "main", "sessions", "sessions.json");
    const events = [
      {
        type: "message",
        id: "sqlite-built-archive-message",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "packaged archive worker marker" }],
        },
        timestamp: Date.now(),
      } as unknown as TestTranscriptEvent,
    ];
    const expectedArchiveContent = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

    try {
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
      const databasePath = requireSqliteDatabasePath(storePath);
      expect(readSessionRowCounts(databasePath, sessionId)).toEqual({
        fts: 1,
        sessionWindows: 1,
        transcriptEvents: 1,
      });
      closeOpenClawAgentDatabasesForTest();

      await expect(inst.entrypoint()).resolves.toEqual(
        expect.arrayContaining([expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u)]),
      );
      await inst.startGateway();
      client = await connectGatewayClient({
        url: inst.url,
        token: inst.gatewayToken,
        clientDisplayName: "sqlite-built-archive-worker",
        requestTimeoutMs: 20_000,
        timeoutMs: 20_000,
      });
      const deleteResult = await client.request<{
        archived?: string[];
        deleted?: boolean;
        ok?: boolean;
      }>("sessions.delete", { key: sessionKey, deleteTranscript: true }, { timeoutMs: 20_000 });
      expect(deleteResult).toMatchObject({ ok: true, deleted: true });
      const archivedPath = deleteResult.archived?.[0];
      expect(archivedPath).toBeTruthy();

      await disconnectGatewayClient(client);
      client = undefined;
      await inst.stopGateway();

      const archivedContent = readSessionArchiveContentSync(archivedPath ?? "");
      expect(Buffer.byteLength(archivedContent)).toBe(Buffer.byteLength(expectedArchiveContent));
      expect(sha256(archivedContent)).toBe(sha256(expectedArchiveContent));
      expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
      await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([]);
      expect(readSessionRowCounts(databasePath, sessionId)).toEqual({
        fts: 0,
        sessionWindows: 0,
        transcriptEvents: 0,
      });
    } finally {
      if (client) {
        await disconnectGatewayClient(client);
      }
      await inst.stopGateway();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await inst.cleanup();
    }
  }, 90_000);
});

type TestTranscriptEvent = Parameters<typeof replaceTranscriptEvents>[1][number];

function requireSqliteDatabasePath(storePath: string): string {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`could not resolve SQLite database path for ${storePath}`);
  }
  return target.path;
}

function readSessionRowCounts(
  databasePath: string,
  sessionId: string,
): {
  fts: number;
  sessionWindows: number;
  transcriptEvents: number;
} {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (table: "session_transcript_fts" | "session_windows" | "transcript_events") => {
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { count: number };
      return row.count;
    };
    return {
      fts: count("session_transcript_fts"),
      sessionWindows: count("session_windows"),
      transcriptEvents: count("transcript_events"),
    };
  } finally {
    database.close();
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
