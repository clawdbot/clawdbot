import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctorMemoryIsolation } from "../../commands/doctor-memory-isolation.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetMemoryIsolationCutoverForTest } from "../../plugins/memory-cutover.js";
import {
  persistMemoryRunExposureBeforeContentInDatabase,
  readDurableMemoryRunExposure,
} from "../../plugins/memory-run-exposure-ledger.js";
import {
  clearMemoryRunExposureForTest,
  prepareMemoryRunExposure,
} from "../../plugins/memory-run-exposure.js";
import { createCurrentMemorySessionContext } from "../../state/memory-session-subject.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { readSessionTranscriptMessageEvents } from "./session-accessor.sqlite-active-events.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { planSqliteSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import {
  loadLatestSqliteAssistantText,
  loadSqliteTranscriptEventsSync,
  loadSqliteTranscriptTailEventsSync,
} from "./session-accessor.sqlite-read.js";
import { readActiveTranscriptAppendParentId } from "./session-accessor.sqlite-transcript-store.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptMessage,
  replaceSqliteTranscriptEvents,
  trimSqliteTranscriptForManualCompact,
} from "./session-accessor.sqlite-transcript-write.js";
import {
  preserveTranscriptMemoryPolicyTransitionInTransaction,
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
  // The transcript companion resolves stable policy identity from the exposed
  // resource revision. Test receipts intentionally stay opaque plugin payloads.
  database.db.exec(/* sqlite-allow-raw: test fixture establishes durable policy lineage. */ `
    INSERT INTO memory_storage_roots
      (storage_root_id, agent_id, backend_kind, opaque_locator, path_key_version, path_key,
       authority_kind, authority_owner_id, default_capabilities_json, lifecycle_state, created_at, updated_at)
    VALUES ('root-1', 'main', 'builtin', 'builtin:v1:test', 1, 's1_test_fixture_path_key_000',
            'user', 'alice', '["read"]', 'active', 1, 1);
    INSERT INTO memory_policies
      (policy_id, agent_id, current_revision_id, revocation_epoch, lifecycle_state, created_at, updated_at)
    VALUES ('policy-1', 'main', 'policy-revision-1', 0, 'active', 1, 1);
    INSERT INTO memory_policy_revisions
      (revision_id, policy_id, revision_number, revocation_epoch, lifecycle_state,
       actor_kind, actor_id, reason, created_at)
    VALUES ('policy-revision-1', 'policy-1', 1, 0, 'active', 'human', 'alice', 'fixture', 1);
    INSERT INTO memory_stores
      (store_id, agent_id, storage_root_id, policy_id, scope_kind, audience_kind, audience_id,
       lifecycle_state, created_at, updated_at)
    VALUES ('store-1', 'main', 'root-1', 'policy-1', 'user', 'user', 'alice', 'active', 1, 1);
    INSERT INTO memory_resources
      (resource_id, agent_id, store_id, logical_locator, source, created_at)
    VALUES ('resource-1', 'main', 'store-1', 'memory/fixture.md', 'memory', 1);
    INSERT INTO memory_resource_revisions
      (revision_id, resource_id, revision_number, artifact_locator, content_hash, content_bytes,
       policy_revision_id, policy_revocation_epoch, source_policy_set_id, lifecycle_state,
       actor_kind, actor_id, expires_at, created_at, activated_at, retired_at)
    VALUES ('resource-revision-1', 'resource-1', 1, 'fixture.md', 'fixture', 7,
            'policy-revision-1', 0, 'plugin-policy-set-1', 'active', 'human', 'alice', NULL, 1, 1, NULL);
  `);
  resetTranscriptMemoryPolicyForTest(database.db);
  return database;
}

function seedTranscriptPolicyFixture(database: OpenClawAgentDatabase): void {
  database.db.exec(/* sqlite-allow-raw: test fixture establishes durable policy lineage. */ `
    INSERT INTO memory_storage_roots
      (storage_root_id, agent_id, backend_kind, opaque_locator, path_key_version, path_key,
       authority_kind, authority_owner_id, default_capabilities_json, lifecycle_state, created_at, updated_at)
    VALUES ('root-shadow', 'main', 'builtin', 'builtin:v1:shadow', 1, 's1_shadow_fixture_path_key_000',
            'user', 'alice', '["read"]', 'active', 1, 1);
    INSERT INTO memory_policies
      (policy_id, agent_id, current_revision_id, revocation_epoch, lifecycle_state, created_at, updated_at)
    VALUES ('policy-shadow', 'main', 'policy-shadow-revision-1', 0, 'active', 1, 1);
    INSERT INTO memory_policy_revisions
      (revision_id, policy_id, revision_number, revocation_epoch, lifecycle_state,
       actor_kind, actor_id, reason, created_at)
    VALUES ('policy-shadow-revision-1', 'policy-shadow', 1, 0, 'active', 'human', 'alice', 'fixture', 1);
    INSERT INTO memory_stores
      (store_id, agent_id, storage_root_id, policy_id, scope_kind, audience_kind, audience_id,
       lifecycle_state, created_at, updated_at)
    VALUES ('store-shadow', 'main', 'root-shadow', 'policy-shadow', 'agent', 'agent', 'main', 'active', 1, 1);
    INSERT INTO memory_resources
      (resource_id, agent_id, store_id, logical_locator, source, created_at)
    VALUES ('resource-shadow', 'main', 'store-shadow', 'memory/shadow.md', 'memory', 1);
    INSERT INTO memory_resource_revisions
      (revision_id, resource_id, revision_number, artifact_locator, content_hash, content_bytes,
       policy_revision_id, policy_revocation_epoch, source_policy_set_id, lifecycle_state,
       actor_kind, actor_id, expires_at, created_at, activated_at, retired_at)
    VALUES ('resource-revision-1', 'resource-shadow', 1, 'shadow.md', 'shadow', 6,
            'policy-shadow-revision-1', 0, 'plugin-policy-set-1', 'active', 'human', 'alice', NULL, 1, 1, NULL);
  `);
}

function recordExposure(params: {
  runId: string;
  subjectRevision?: string;
  sessionIdentityRevision?: string;
}) {
  return prepareMemoryRunExposure({
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
    actorEvidence: {
      version: 1,
      kind: "principal",
      actorKind: "human",
      principalId: "alice",
      assurance: "gateway-profile",
      evidenceRevision: "actor-revision-1",
    },
    delegationSnapshot: { version: 1, kind: "none" },
    hostFactsRevision: "host-facts-1",
  });
}

function persistExposure(
  database: OpenClawAgentDatabase,
  params: Parameters<typeof recordExposure>[0],
) {
  const exposure = recordExposure(params);
  expect(persistMemoryRunExposureBeforeContentInDatabase({ database, snapshot: exposure })).toBe(
    true,
  );
  return exposure;
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

function copyPendingTranscriptForTransition(params: {
  database: OpenClawAgentDatabase;
  sourceSessionId?: string;
  subjectRevision?: string;
  targetSessionId: string;
}): void {
  const sourceSessionId = params.sourceSessionId ?? SESSION_ID;
  const targetSessionKey = `${SESSION_KEY}:transition:${params.targetSessionId}`;
  const subjectRevision = params.subjectRevision ?? SUBJECT_REVISION;
  params.database.db
    .prepare(
      `INSERT INTO session_memory_subjects
        (session_key, subject_kind, binding_id, principal_id, subject_revision, created_at)
       VALUES (?, 'user', 'binding-transition', 'alice', ?, 1)`,
    )
    .run(targetSessionKey, subjectRevision);
  writeSessionEntry(params.database, targetSessionKey, {
    sessionId: params.targetSessionId,
    updatedAt: 1,
  });
  const sourceRows = params.database.db
    .prepare(
      `SELECT created_at, event_json, seq
         FROM transcript_events
        WHERE session_id = ?
        ORDER BY seq ASC`,
    )
    .all(sourceSessionId) as Array<{ created_at: number; event_json: string; seq: number }>;
  for (const row of sourceRows) {
    params.database.db
      .prepare(
        `INSERT INTO transcript_events (session_id, seq, event_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(params.targetSessionId, row.seq, row.event_json, row.created_at);
    params.database.db
      .prepare(
        `INSERT INTO transcript_event_memory_policies
          (session_id, event_seq, authorization_status, source_policy_set_id, run_exposure_set_id,
           run_exposure_revision, delivery_audiences_json, session_identity_revision,
           subject_revision, run_id, context_fingerprint, created_at)
         VALUES (?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(params.targetSessionId, row.seq, row.created_at);
  }
}

afterEach(() => {
  clearMemoryRunExposureForTest();
  resetMemoryIsolationCutoverForTest();
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("transcript memory policy companions", () => {
  it("enforces Doctor shadow-read-only companion persistence for only its bound subject", async () => {
    const env = createEnv();
    const options = { agentId: AGENT_ID, env };
    const alice = { sessionId: "shadow-alice", sessionKey: "agent:main:shadow-alice" };
    const bob = { sessionId: "shadow-bob", sessionKey: "agent:main:shadow-bob" };
    const writeSession = (session: typeof alice) =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          writeSessionEntry(database, session.sessionKey, {
            sessionId: session.sessionId,
            updatedAt: 1,
            createdVia: "spawn",
          });
        },
        options,
        { operationLabel: "session-transcript-memory-policy.test.shadow-subject" },
      );

    writeSession(alice);
    const database = openOpenClawAgentDatabase(options);
    seedTranscriptPolicyFixture(database);
    const aliceContext = createCurrentMemorySessionContext({ ...alice, options });
    expect(aliceContext.kind).toBe("current");
    if (aliceContext.kind !== "current") {
      throw new Error("expected lifecycle-owned Alice subject context");
    }
    await appendSqliteTranscriptMessage(
      { ...alice, agentId: AGENT_ID, env },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "legacy shadow search content" }],
        },
      },
    );

    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR ?? "");
    expect(
      runDoctorMemoryIsolation({
        action: "shadow-read-only",
        cfg: { agents: { list: [{ id: AGENT_ID, default: true }] } } as OpenClawConfig,
        nowMs: 1,
      }),
    ).toMatchObject({ agentId: AGENT_ID, mode: "shadow-read-only", restartRequired: true });
    // Doctor writes out of process. Refresh the process-owned snapshot to model the required
    // Gateway restart before proving the protected transcript boundary.
    resetMemoryIsolationCutoverForTest();
    resetTranscriptMemoryPolicyForTest(database.db);
    expect(
      searchSessionTranscripts({
        agentId: AGENT_ID,
        env,
        query: "legacy shadow search content",
      }).hits,
    ).toEqual([]);

    const shadowExposure = prepareMemoryRunExposure({
      agentId: AGENT_ID,
      sessionId: alice.sessionId,
      sessionKey: alice.sessionKey,
      runId: "shadow-alice-run",
      contextFingerprint: "shadow-alice-context",
      planId: "shadow-alice-plan",
      memoryPolicyRevision: "memory-policy-revision-1",
      sourcePolicySetIds: ["plugin-policy-set-1"],
      exposedResourceRevisions: ["resource-revision-1"],
      exposureReceiptIds: ["exposure-receipt-1"],
      egressReceiptIds: ["egress-receipt-1"],
      deliveryAudiences: [{ kind: "agent", id: aliceContext.context.principalId }],
      deliveryRevision: "delivery-revision-1",
      egressRegistryRevision: "egress-registry-revision-1",
      sessionIdentityRevision: aliceContext.context.sessionIdentityRevision,
      subjectRevision: aliceContext.context.subjectRevision,
      actorEvidence: {
        version: 1,
        kind: "principal",
        actorKind: "human",
        principalId: aliceContext.context.principalId,
        assurance: "gateway-profile",
        evidenceRevision: "shadow-actor-revision-1",
      },
      delegationSnapshot: { version: 1, kind: "none" },
      hostFactsRevision: "shadow-host-facts-1",
    });
    expect(
      persistMemoryRunExposureBeforeContentInDatabase({ database, snapshot: shadowExposure }),
    ).toBe(true);
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          agentId: AGENT_ID,
          expectedWriterRunId: "shadow-alice-run",
          sessionId: alice.sessionId,
          sessionKey: alice.sessionKey,
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        await appendSqliteTranscriptMessage(
          { ...alice, agentId: AGENT_ID, env },
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "alice scoped content" }],
            },
          },
        );
      },
    );
    expect(readAuthorizedTranscriptEventSeqs(database.db, alice.sessionId)?.size).toBeGreaterThan(
      0,
    );
    expect(loadSqliteTranscriptEventsSync({ ...alice, agentId: AGENT_ID, env })).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "alice scoped content" }],
        }),
      }),
    );
    const searchAlice = () =>
      searchSessionTranscripts({ agentId: AGENT_ID, env, query: "alice scoped content" });
    await vi.waitFor(() => expect(searchAlice().indexing).toBe(false), {
      interval: 10,
      timeout: 15_000,
    });
    expect(searchAlice().hits).toHaveLength(1);

    writeSession(bob);
    expect(createCurrentMemorySessionContext({ ...bob, options })).toEqual({
      kind: "shadow-subject-mismatch",
    });
    await appendSqliteTranscriptMessage(
      { ...bob, agentId: AGENT_ID, env },
      {
        message: { role: "assistant", content: [{ type: "text", text: "bob denied content" }] },
      },
    );
    expect(readAuthorizedTranscriptEventSeqs(database.db, bob.sessionId)).toEqual(new Set());
    expect(loadSqliteTranscriptEventsSync({ ...bob, agentId: AGENT_ID, env })).toEqual([]);
  });

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
    persistExposure(database, { runId: "stale-run", subjectRevision: "stale-subject-revision" });
    await appendWithRun({ env, runId: "stale-run", text: "stale exposure content" });
    const authorizedExposure = persistExposure(database, { runId: "authorized-run" });
    expect(
      readDurableMemoryRunExposure({
        database,
        sessionId: SESSION_ID,
        runId: "authorized-run",
      }),
    ).toMatchObject({ exposureSetId: authorizedExposure.exposureSetId });
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
      {
        authorization_status: "authorized",
        run_id: authorizedExposure.durableRunScopeId,
      },
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
    persistExposure(database, { runId: "authorized-run" });
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
    persistExposure(database, { runId: "authorized-run" });
    database.db.exec(/* sqlite-allow-raw: test-only atomicity fault injection. */ `
      CREATE TRIGGER reject_transcript_memory_policy_detail_for_test
      BEFORE INSERT ON transcript_event_memory_policy_details
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
      "transcript_event_memory_policy_details",
      "memory_policy_sets",
      "memory_policy_set_members",
      "memory_run_exposures",
      "memory_run_exposure_resources",
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    // The pre-output ledger commits before content leaves the memory broker, outside this
    // transcript transaction; a later companion rollback must not erase its audit fact.
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM memory_preoutput_exposure_ledger").get(),
    ).toEqual({ count: 1 });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM memory_preoutput_exposure_authorization_facts")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("replays only committed current companions after a fresh database consumer starts", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    persistExposure(database, { runId: "authorized-run" });
    clearMemoryRunExposureForTest();
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
    persistExposure(database, { runId: "authorized-run" });
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
    const sourceEventCount = database.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
      .get(SESSION_ID);
    await expect(materializeSqliteSessionStateDeletePlans([plan!])).rejects.toThrow(
      `Unauthorized transcript policy archive event for ${SESSION_ID}`,
    );
    // Archive failure preserves the raw source rather than leaking it or deleting it.
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
        .get(SESSION_ID),
    ).toEqual(sourceEventCount);
  });

  it("records complete policy evidence for every readable transcript event class", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    persistExposure(database, { runId: "event-classes-run" });

    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          agentId: AGENT_ID,
          expectedWriterRunId: "event-classes-run",
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        await appendSqliteTranscriptMessage(scope(env), {
          message: { role: "user", content: [{ type: "text", text: "user event" }] },
        });
        await appendSqliteTranscriptMessage(scope(env), {
          message: { role: "assistant", content: [{ type: "text", text: "assistant event" }] },
        });
        for (const type of ["tool-result", "summary", "checkpoint", "system"] as const) {
          await appendSqliteTranscriptEvent(scope(env), { type, value: `${type} event` });
        }
      },
    );

    const companions = database.db
      .prepare(
        `SELECT policy.authorization_status, detail.actor_evidence_json, detail.delegation_snapshot_json,
                detail.exposed_resource_revisions_json, detail.normalized_audience_intersection_json,
                detail.finalized_delivery_audiences_json, detail.source_session_id, detail.source_event_seq
           FROM transcript_event_memory_policies AS policy
           JOIN transcript_event_memory_policy_details AS detail
             ON detail.session_id = policy.session_id AND detail.event_seq = policy.event_seq
          WHERE policy.session_id = ?
          ORDER BY policy.event_seq`,
      )
      .all(SESSION_ID) as Array<{
      actor_evidence_json: string;
      authorization_status: string;
      delegation_snapshot_json: string;
      exposed_resource_revisions_json: string;
      finalized_delivery_audiences_json: string;
      normalized_audience_intersection_json: string;
      source_event_seq: number;
      source_session_id: string;
    }>;
    // Header plus six requested classes all carry one atomic, evaluable row.
    expect(companions).toHaveLength(7);
    expect(companions.every((companion) => companion.authorization_status === "authorized")).toBe(
      true,
    );
    for (const companion of companions) {
      expect(JSON.parse(companion.actor_evidence_json)).toMatchObject({ principalId: "alice" });
      expect(JSON.parse(companion.delegation_snapshot_json)).toMatchObject({ kind: "none" });
      expect(JSON.parse(companion.exposed_resource_revisions_json)).toEqual([
        "resource-revision-1",
      ]);
      expect(companion.normalized_audience_intersection_json).toBe(
        companion.finalized_delivery_audiences_json,
      );
      expect(companion.source_session_id).toBe(SESSION_ID);
      expect(companion.source_event_seq).toBeGreaterThanOrEqual(0);
    }
    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)?.size).toBe(7);
  });

  it("uses the captured trusted actor and token-free delegation rather than reconstructing session facts", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    const captured = recordExposure({ runId: "delegated-run" });
    const exposure = {
      ...captured,
      actorEvidence: {
        version: 1,
        kind: "principal",
        actorKind: "agent",
        principalId: "support-agent",
        assurance: "service",
        evidenceRevision: "actor-evidence-42",
      },
      delegationSnapshot: {
        version: 1,
        kind: "delegated",
        rootPrincipalId: "alice",
        rootContextId: "root-context-42",
        parentContextId: "parent-context-42",
        parentMemoryPlanId: "parent-plan-42",
        capabilitySnapshotId: "capability-42",
        allowedOperations: ["derive", "read"],
        maximumAudiences: [
          { kind: "role", id: "writer" },
          { kind: "user", id: "alice" },
        ],
        depth: 1,
      },
      hostFactsRevision: "host-facts-42",
    } as typeof captured;
    expect(persistMemoryRunExposureBeforeContentInDatabase({ database, snapshot: exposure })).toBe(
      true,
    );

    await appendWithRun({ env, runId: "delegated-run", text: "delegated durable evidence" });

    const row = database.db
      .prepare(
        `SELECT actor_evidence_json, delegation_snapshot_json
           FROM transcript_event_memory_policy_details
          WHERE session_id = ?
          ORDER BY event_seq DESC
          LIMIT 1`,
      )
      .get(SESSION_ID) as { actor_evidence_json: string; delegation_snapshot_json: string };
    expect(JSON.parse(row.actor_evidence_json)).toEqual(exposure.actorEvidence);
    expect(JSON.parse(row.delegation_snapshot_json)).toEqual(exposure.delegationSnapshot);
    expect(JSON.stringify(row)).not.toContain("binding-alice");
    expect(JSON.stringify(row)).not.toContain("storeCapToken");
  });

  it("withdraws replay eligibility when the captured stable policy revision or epoch changes", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    persistExposure(database, { runId: "policy-revision-run" });
    await appendWithRun({ env, runId: "policy-revision-run", text: "revision-bound secret" });
    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)?.size).toBeGreaterThan(0);

    database.db.exec(/* sqlite-allow-raw: test mutates the active policy owner after capture. */ `
      UPDATE memory_policy_revisions
         SET lifecycle_state = 'superseded'
       WHERE revision_id = 'policy-revision-1';
      INSERT INTO memory_policy_revisions
        (revision_id, policy_id, revision_number, revocation_epoch, lifecycle_state,
         actor_kind, actor_id, reason, created_at)
      VALUES ('policy-revision-2', 'policy-1', 2, 1, 'active', 'human', 'alice', 'revoked', 2);
      UPDATE memory_policies
         SET current_revision_id = 'policy-revision-2', revocation_epoch = 1, updated_at = 2
       WHERE policy_id = 'policy-1';
    `);

    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)).toEqual(new Set());
    expect(loadSqliteTranscriptEventsSync(scope(env))).toEqual([]);
    expect(
      searchSessionTranscripts({ agentId: AGENT_ID, env, query: "revision-bound secret" }).hits,
    ).toEqual([]);
  });

  it("withdraws dependent events when an exposed resource expires", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    persistExposure(database, { runId: "resource-expiry-run" });
    await appendWithRun({ env, runId: "resource-expiry-run", text: "resource-bound secret" });
    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)?.size).toBeGreaterThan(0);

    database.db.exec(/* sqlite-allow-raw: test advances an immutable lease past expiry. */ `
      DROP TRIGGER memory_resource_revisions_immutable_fields;
      UPDATE memory_resource_revisions
         SET expires_at = ${Date.now() - 1}
       WHERE revision_id = 'resource-revision-1';
    `);

    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)).toEqual(new Set());
    expect(loadSqliteTranscriptEventsSync(scope(env))).toEqual([]);
  });

  it("preserves only exact same-session replacement lineage and leaves new rows pending", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    persistExposure(database, { runId: "replace-lineage-run" });
    await appendWithRun({ env, runId: "replace-lineage-run", text: "retained source" });

    const original = loadSqliteTranscriptEventsSync(scope(env));
    const retainedMessage = original.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "message" in event &&
        (event as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]
          ?.text === "retained source",
    );
    expect(retainedMessage).toBeDefined();
    await replaceSqliteTranscriptEvents(scope(env), [retainedMessage!]);

    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)).toEqual(new Set([0]));
    expect(
      database.db
        .prepare(
          `SELECT source_event_seq
             FROM transcript_event_memory_policy_details
            WHERE session_id = ? AND event_seq = 0`,
        )
        .get(SESSION_ID),
    ).toEqual({ source_event_seq: 1 });

    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          agentId: AGENT_ID,
          expectedWriterRunId: "replace-lineage-run",
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
        },
        withTranscriptWrite: async (run) => await run(),
      },
      async () => {
        await replaceSqliteTranscriptEvents(scope(env), [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "new derived content" }],
            },
          },
        ]);
      },
    );
    expect(readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID)).toEqual(new Set());
    expect(
      database.db
        .prepare(
          `SELECT authorization_status
             FROM transcript_event_memory_policies
            WHERE session_id = ? AND event_seq = 0`,
        )
        .get(SESSION_ID),
    ).toEqual({ authorization_status: "pending" });
  });

  it("preserves a cross-session transition only with matching immutable subject provenance", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    persistExposure(database, { runId: "transition-run" });
    await appendWithRun({ env, runId: "transition-run", text: "transition source" });
    const sourceSeqs = readAuthorizedTranscriptEventSeqs(database.db, SESSION_ID);
    expect(sourceSeqs?.size).toBeGreaterThan(0);

    const targetSessionId = "transition-target";
    copyPendingTranscriptForTransition({
      database,
      targetSessionId,
    });
    expect(
      preserveTranscriptMemoryPolicyTransitionInTransaction({
        database,
        sourceSessionId: SESSION_ID,
        targetSessionId,
        transitionKind: "fork",
      }),
    ).toBe(sourceSeqs?.size);
    expect(readAuthorizedTranscriptEventSeqs(database.db, targetSessionId)).toEqual(sourceSeqs);
    expect(
      database.db
        .prepare(
          `SELECT source_session_id, source_event_seq, transition_kind
             FROM transcript_event_memory_policy_transitions
            WHERE session_id = ?
            ORDER BY event_seq ASC`,
        )
        .all(targetSessionId),
    ).toEqual(
      [...(sourceSeqs ?? [])].map((sourceEventSeq) => ({
        source_session_id: SESSION_ID,
        source_event_seq: sourceEventSeq,
        transition_kind: "fork",
      })),
    );
  });

  it("leaves a cross-session copy pending when its target subject differs", async () => {
    const env = createEnv();
    const database = markCutOver(env);
    persistExposure(database, { runId: "transition-mismatch-run" });
    await appendWithRun({ env, runId: "transition-mismatch-run", text: "isolated source" });

    const targetSessionId = "transition-mismatched-subject";
    copyPendingTranscriptForTransition({
      database,
      subjectRevision: "different-subject-revision",
      targetSessionId,
    });
    expect(
      preserveTranscriptMemoryPolicyTransitionInTransaction({
        database,
        sourceSessionId: SESSION_ID,
        targetSessionId,
        transitionKind: "parent-fork",
      }),
    ).toBe(0);
    expect(readAuthorizedTranscriptEventSeqs(database.db, targetSessionId)).toEqual(new Set());
    expect(
      database.db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM transcript_event_memory_policy_transitions
            WHERE session_id = ?`,
        )
        .get(targetSessionId),
    ).toEqual({ count: 0 });
  });
});
