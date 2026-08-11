import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import { appendSqliteTranscriptMessage } from "./session-accessor.sqlite-transcript-write.js";
import { resetTranscriptMemoryPolicyForTest } from "./session-transcript-memory-policy.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("readTranscriptMirrorFacts", () => {
  it("does not expose an unlabeled pre-cutover event when the identity index claims current", async () => {
    const root = tempDirs.make("openclaw-transcript-mirror-cutover-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const scope = {
      agentId: "main",
      env,
      sessionId: "mirror-cutover-session",
      sessionKey: "agent:main:mirror-cutover",
    };
    const idempotencyKey = "legacy-mirror-message";

    await appendSqliteTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "legacy private mirror content" }],
        idempotencyKey,
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env });
    const indexState = database.db
      .prepare(
        `SELECT state.indexed_seq, state.needs_rebuild, MAX(event.seq) AS latest_seq
         FROM session_transcript_index_state AS state
         INNER JOIN transcript_events AS event ON event.session_id = state.session_id
         WHERE state.session_id = ?`,
      )
      .get(scope.sessionId) as {
      indexed_seq: number;
      latest_seq: number;
      needs_rebuild: number;
    };
    expect(indexState).toMatchObject({ needs_rebuild: 0 });
    expect(indexState.indexed_seq).toBe(indexState.latest_seq);

    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES (?, 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
      )
      .run("mirror-cutover-test");
    resetTranscriptMemoryPolicyForTest(database.db);

    expect(
      readTranscriptMirrorFacts(database, resolveSqliteTranscriptScope(scope), {
        idempotencyKeys: [idempotencyKey],
      }),
    ).toEqual({
      anchorsByIdempotencyKey: new Map(),
      existingIdempotencyKeys: new Set(),
      messagesByIdempotencyKey: new Map(),
    });
  });

  it("keeps an unlabeled pre-cutover event out of the raw fallback while the projection rebuilds", async () => {
    const root = tempDirs.make("openclaw-transcript-mirror-fallback-cutover-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const scope = {
      agentId: "main",
      env,
      sessionId: "mirror-fallback-cutover-session",
      sessionKey: "agent:main:mirror-fallback-cutover",
    };
    const idempotencyKey = "legacy-mirror-fallback-message";

    await appendSqliteTranscriptMessage(scope, {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "legacy private fallback mirror content" }],
        idempotencyKey,
      },
    });

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env });
    database.db
      .prepare(
        `INSERT INTO memory_migrations
          (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
           verified_at, cutover_at, updated_at)
         VALUES (?, 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
      )
      .run("mirror-fallback-cutover-test");
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    resetTranscriptMemoryPolicyForTest(database.db);

    expect(
      readTranscriptMirrorFacts(database, resolveSqliteTranscriptScope(scope), {
        idempotencyKeys: [idempotencyKey],
      }),
    ).toEqual({
      anchorsByIdempotencyKey: new Map(),
      existingIdempotencyKeys: new Set(),
      messagesByIdempotencyKey: new Map(),
    });
  });
});
