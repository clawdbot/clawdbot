import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryRunExposureForTest,
  recordMemoryRunExposure,
} from "../../plugins/memory-run-exposure.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readSessionTranscriptMessageEvents } from "./session-accessor.sqlite-active-events.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { planSqliteSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import {
  loadLatestSqliteAssistantText,
  loadSqliteTranscriptEventsSync,
  loadSqliteTranscriptTailEventsSync,
} from "./session-accessor.sqlite-read.js";
import { readActiveTranscriptAppendParentId } from "./session-accessor.sqlite-transcript-store.js";
import {
  appendSqliteTranscriptMessage,
  trimSqliteTranscriptForManualCompact,
} from "./session-accessor.sqlite-transcript-write.js";
import {
  readAuthorizedTranscriptEventSeqs,
  resetTranscriptMemoryPolicyForTest,
} from "./session-transcript-memory-policy.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";
import { withOwnedSessionTranscriptWrites } from "./transcript-write-context.js";

const AGENT_ID = "main";
const SESSION_ID = "session-memory-policy";
const SESSION_KEY = "agent:main:memory-policy";
const SUBJECT_REVISION = "subject-revision-current";
const SESSION_IDENTITY_REVISION = "session-identity-revision-current";

const roots: string[] = [];

function createEnv(): NodeJS.ProcessEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-transcript-memory-policy-"));
  roots.push(root);
  return { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
}

function scope(env: NodeJS.ProcessEnv) {
  return { agentId: AGENT_ID, env, sessionId: SESSION_ID, sessionKey: SESSION_KEY };
}

function markCutOver(env: NodeJS.ProcessEnv) {
  const database = openOpenClawAgentDatabase({ agentId: AGENT_ID, env });
  database.db
    .prepare(
      `INSERT INTO memory_migrations
        (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
         verified_at, cutover_at, updated_at)
       VALUES (?, 'test', 'test-source', 'cutover', '{}', 'test-plan', 1, 1, 1)`,
    )
    .run("memory-cutover-test");
  database.db
    .prepare(
      `INSERT INTO session_memory_subjects
        (session_key, subject_kind, binding_id, principal_id, subject_revision, created_at)
       VALUES (?, 'user', 'binding-alice', 'alice', ?, 1)`,
    )
    .run(SESSION_KEY, SUBJECT_REVISION);
  database.db
    .prepare(
      `INSERT INTO session_memory_subject_snapshots
        (session_id, session_key, subject_revision, session_identity_revision, created_at)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(SESSION_ID, SESSION_KEY, SUBJECT_REVISION, SESSION_IDENTITY_REVISION);
  resetTranscriptMemoryPolicyForTest(database.db);
  return database;
}

function recordExposure(params: {
  runId: string;
  subjectRevision?: string;
  sessionIdentityRevision?: string;
}) {
  return recordMemoryRunExposure({
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    runId: params.runId,
    contextFingerprint: `context-${params.runId}`,
    planId: `plan-${params.runId}`,
    memoryPolicyRevision: "memory-policy-revision-1",
    sourcePolicySetIds: ["plugin-policy-set-1"],
    exposedResourceRevisions: ["resource-revision-1"],
    exposureReceiptIds: ["exposure-receipt-1"],
    egressReceiptIds: ["egress-receipt-1"],
    deliveryAudiences: [{ kind: "user", id: "alice" }],
    deliveryRevision: "delivery-revision-1",
    egressRegistryRevision: "egress-registry-revision-1",
    sessionIdentityRevision: params.sessionIdentityRevision ?? SESSION_IDENTITY_REVISION,
    subjectRevision: params.subjectRevision ?? SUBJECT_REVISION,
  });
}

async function appendWithRun(params: { env: NodeJS.ProcessEnv; runId: string; text: string }) {
  await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: {
        agentId: AGENT_ID,
        expectedWriterRunId: params.runId,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      },
      withTranscriptWrite: async (run) => await run(),
    },
    async () => {
      await appendSqliteTranscriptMessage(scope(params.env), {
        message: { role: "assistant", content: [{ type: "text", text: params.text }] },
      });
    },
  );
}

afterEach(() => {
  clearMemoryRunExposureForTest();
  closeOpenClawAgentDatabasesForTest();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("transcript memory policy companions", () => {
  it("fails closed for missing or stale run exposure while indexing only an authorized event", async () => {
    const env = createEnv();
    // Establish the SQLite session before the cut-over marker is written; its old row has no
    // companion and must disappear as soon as the enforced policy reader is active.
    await appendSqliteTranscriptMessage(scope(env), {
      message: { role: "assistant", content: [{ type: "text", text: "legacy private content" }] },
    });
    const database = markCutOver(env);

    await appendSqliteTranscriptMessage(scope(env), {
      message: { role: "assistant", content: [{ type: "text", text: "missing exposure content" }] },
    });
    recordExposure({ runId: "stale-run", subjectRevision: "stale-subject-revision" });
    await appendWithRun({ env, runId: "stale-run", text: "stale exposure content" });
    recordExposure({ runId: "authorized-run" });
    await appendWithRun({ env, runId: "authorized-run", text: "authorized exposure content" });

    const policyRows = database.db
      .prepare(
        `SELECT authorization_status, run_id
         FROM transcript_event_memory_policies
         WHERE session_id = ?
         ORDER BY event_seq`,
      )
      .all(SESSION_ID) as Array<{ authorization_status: string; run_id: string | null }>;
    expect(policyRows.filter((row) => row.authorization_status === "authorized")).toEqual([
      { authorization_status: "authorized", run_id: "authorized-run" },
    ]);
    expect(policyRows.filter((row) => row.authorization_status === "pending")).toHaveLength(2);
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM memory_policy_sets").get()).toEqual({
      count: 1,
    });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM memory_run_exposures").get()).toEqual(
      { count: 1 },
    );

    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)).toEqual(new Set([4]));
    expect(loadSqliteTranscriptEventsSync(scope(env))).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "authorized exposure content" }],
        }),
      }),
    ]);
    expect(loadSqliteTranscriptTailEventsSync(scope(env), 2)).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "authorized exposure content" }],
        }),
      }),
    ]);
    expect(loadLatestSqliteAssistantText(scope(env))).toMatchObject({
      text: "authorized exposure content",
    });

    const search = () =>
      searchSessionTranscripts({ agentId: AGENT_ID, env, query: "exposure content" });
    await vi.waitFor(() => expect(search().indexing).toBe(false), {
      interval: 10,
      timeout: 15_000,
    });
    const hits = search().hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("authorized exposure content");
    expect(hits[0]?.snippet).not.toContain("missing exposure content");
    expect(hits[0]?.snippet).not.toContain("stale exposure content");
    expect(readSessionTranscriptMessageEvents(scope(env))).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "authorized exposure content" }],
          }),
        }),
      }),
    ]);
  });

  it("does not derive an append parent from a pending transcript event", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    recordExposure({ runId: "authorized-run" });
    let authorizedMessageId: string | undefined;
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          agentId: AGENT_ID,
          expectedWriterRunId: "authorized-run",
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        authorizedMessageId = (
          await appendSqliteTranscriptMessage(scope(env), {
            message: { role: "assistant", content: [{ type: "text", text: "authorized" }] },
          })
        ).messageId;
      },
    );
    const pending = await appendSqliteTranscriptMessage(scope(env), {
      message: { role: "assistant", content: [{ type: "text", text: "pending" }] },
    });

    expect(readActiveTranscriptAppendParentId(database, SESSION_ID)).toBe(authorizedMessageId);
    expect(readActiveTranscriptAppendParentId(database, SESSION_ID)).not.toBe(pending.messageId);
  });

  it("does not pass a pending transcript event to manual compaction", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    await appendSqliteTranscriptMessage(scope(env), {
      message: { role: "assistant", content: [{ type: "text", text: "pending" }] },
    });
    const selectRetainedLines = vi.fn(() => null);

    await expect(
      trimSqliteTranscriptForManualCompact(scope(env), selectRetainedLines),
    ).resolves.toEqual({ trimmed: false });

    expect(selectRetainedLines).not.toHaveBeenCalled();
    expect(
      database.db
        .prepare("SELECT authorization_status FROM transcript_event_memory_policies")
        .all(),
    ).toEqual([{ authorization_status: "pending" }, { authorization_status: "pending" }]);
  });

  it("rolls the event and every companion row back when companion persistence fails", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    recordExposure({ runId: "authorized-run" });
    database.db.exec(/* sqlite-allow-raw: test-only atomicity fault injection. */ `
      CREATE TRIGGER reject_transcript_memory_policy_for_test
      BEFORE INSERT ON transcript_event_memory_policies
      BEGIN
        SELECT RAISE(ABORT, 'test companion persistence failure');
      END;
    `);

    await expect(
      appendWithRun({ env, runId: "authorized-run", text: "must not commit" }),
    ).rejects.toThrow("test companion persistence failure");

    for (const table of [
      "transcript_events",
      "transcript_event_memory_policies",
      "memory_policy_sets",
      "memory_run_exposures",
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
  });

  it("replays only committed current companions after a fresh database consumer starts", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    recordExposure({ runId: "authorized-run" });
    await appendWithRun({ env, runId: "authorized-run", text: "committed companion content" });

    const committedRows = database.db
      .prepare(
        `SELECT policy.authorization_status, exposure.exposure_set_id, policy_set.policy_set_id
         FROM transcript_event_memory_policies AS policy
         JOIN memory_run_exposures AS exposure
           ON exposure.exposure_set_id = policy.run_exposure_set_id
         JOIN memory_policy_sets AS policy_set
           ON policy_set.policy_set_id = policy.source_policy_set_id
         WHERE policy.session_id = ?`,
      )
      .all(SESSION_ID) as Array<{ authorization_status: string }>;
    // The first append commits a transcript header and the message together;
    // every committed event must have its linked durable authorization rows.
    expect(committedRows.length).toBeGreaterThan(0);
    expect(committedRows.every((row) => row.authorization_status === "authorized")).toBe(true);
    const committedAuthorizedCount = readAuthorizedTranscriptEventSeqs(
      database.db,
      SESSION_ID,
    )?.size;
    expect(committedAuthorizedCount).toBeGreaterThan(0);

    // The reader must derive durable authorization entirely from the committed
    // companion rows; the producer's process-local exposure snapshot is gone.
    clearMemoryRunExposureForTest();
    closeOpenClawAgentDatabasesForTest();
    let fresh = openOpenClawAgentDatabase({ agentId: AGENT_ID, env });
    expect(readAuthorizedTranscriptEventSeqs(fresh.db, SESSION_ID)?.size).toBe(
      committedAuthorizedCount,
    );
    expect(loadSqliteTranscriptEventsSync(scope(env))).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "committed companion content" }],
        }),
      }),
    );

    // A later durable row without a companion is pending. A separate database
    // consumer must not infer authority from the earlier committed exposure.
    await appendSqliteTranscriptMessage(scope(env), {
      message: { role: "assistant", content: [{ type: "text", text: "missing companion" }] },
    });
    closeOpenClawAgentDatabasesForTest();
    fresh = openOpenClawAgentDatabase({ agentId: AGENT_ID, env });
    expect(readAuthorizedTranscriptEventSeqs(fresh.db, SESSION_ID)?.size).toBe(
      committedAuthorizedCount,
    );
    expect(loadSqliteTranscriptEventsSync(scope(env))).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "committed companion content" }],
        }),
      }),
    );

    // A legacy or out-of-band raw row might have no companion at all. The same
    // fresh consumer must fail closed rather than infer a policy from its event.
    fresh.db
      .prepare(
        `DELETE FROM transcript_event_memory_policies
         WHERE session_id = ? AND authorization_status = 'pending'`,
      )
      .run(SESSION_ID);
    closeOpenClawAgentDatabasesForTest();
    fresh = openOpenClawAgentDatabase({ agentId: AGENT_ID, env });
    expect(readAuthorizedTranscriptEventSeqs(fresh.db, SESSION_ID)?.size).toBe(
      committedAuthorizedCount,
    );
    expect(loadSqliteTranscriptEventsSync(scope(env))).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "committed companion content" }],
        }),
      }),
    );

    // A persisted but stale companion is no better than a missing one after
    // restart: the current join rejects it before any transcript payload opens.
    fresh.db
      .prepare(
        `UPDATE transcript_event_memory_policies
         SET run_exposure_revision = 999
         WHERE session_id = ? AND authorization_status = 'authorized'`,
      )
      .run(SESSION_ID);
    closeOpenClawAgentDatabasesForTest();
    fresh = openOpenClawAgentDatabase({ agentId: AGENT_ID, env });
    expect(readAuthorizedTranscriptEventSeqs(fresh.db, SESSION_ID)).toEqual(new Set());
    expect(loadSqliteTranscriptEventsSync(scope(env))).toEqual([]);
  });

  it("removes a stale companion from replay, search, projections, compaction, and export", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    recordExposure({ runId: "authorized-run" });
    await appendWithRun({ env, runId: "authorized-run", text: "stale companion secret" });

    const search = () =>
      searchSessionTranscripts({ agentId: AGENT_ID, env, query: "stale companion secret" });
    await vi.waitFor(() => expect(search().indexing).toBe(false), {
      interval: 10,
      timeout: 15_000,
    });
    expect(search().hits).toHaveLength(1);

    // A stale exposure revision is indistinguishable from a stale receipt to
    // consumers: current policy joins must drop the otherwise indexed event.
    database.db
      .prepare(
        "UPDATE transcript_event_memory_policies SET run_exposure_revision = ? WHERE session_id = ?",
      )
      .run(999, SESSION_ID);

    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)).toEqual(new Set());
    expect(loadSqliteTranscriptEventsSync(scope(env))).toEqual([]);
    expect(search().hits).toEqual([]);
    expect(() => readSessionTranscriptMessageEvents(scope(env))).toThrow(
      /projection is rebuilding/i,
    );
    await expect(trimSqliteTranscriptForManualCompact(scope(env), vi.fn())).resolves.toEqual({
      trimmed: false,
    });

    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.join(roots.at(-1) ?? "", "archives"),
      archiveTranscript: true,
      database,
      reason: "deleted",
      referencedSessionIds: new Set(),
      sessionId: SESSION_ID,
    });
    expect(plan).not.toBeNull();
    const materialized = await materializeSqliteSessionStateDeletePlans([plan!]);
    expect(materialized[0]?.archivedTranscript).toBeNull();
  });
});
