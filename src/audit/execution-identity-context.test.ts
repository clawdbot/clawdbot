import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { recordAuditEvent } from "./audit-event-store.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";
import {
  inspectExecutionIdentityRun,
  processExecutionIdentityAdmissionWork,
  pruneExpiredExecutionIdentityContexts,
} from "./execution-identity-context.js";

const RETENTION_MS = 30 * 24 * 60 * 60_000;

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-identity-") } };
}

function openIndependentStateDatabase(path: string): OpenClawStateDatabase {
  return {
    db: openNodeSqliteDatabase(path),
    path,
    walMaintenance: { checkpoint: () => true, close: () => true },
  };
}

function facts(
  runId: string,
  overrides: Partial<ExecutionIdentityAdmissionFacts> = {},
): ExecutionIdentityAdmissionFacts {
  return {
    runId,
    agentId: "main",
    ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
    runtime: { kind: "embedded" },
    ...overrides,
  };
}

function captureExecutionIdentityAdmissionEnvelope(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: {
    now?: number;
    contextId?: string;
    executionId?: string;
    runtimeInstanceId?: string;
  } = {},
): ExecutionIdentityAdmissionEnvelope {
  const { contextId, executionId, runtimeInstanceId, now } = options;
  let envelope: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((captured) => {
    if (captured.kind === "capture") {
      envelope = captured.envelope;
    }
    return true;
  });
  try {
    const result = enqueueExecutionIdentityContextAtAdmission(admissionFacts, {
      enabled: true,
      ...(contextId !== undefined ? { contextId } : {}),
      ...(executionId !== undefined ? { executionId } : {}),
      ...(runtimeInstanceId !== undefined ? { runtimeInstanceId } : {}),
      ...(now !== undefined ? { now } : {}),
    });
    if (!result || !envelope) {
      throw new Error("expected admission envelope");
    }
    return envelope;
  } finally {
    clear();
  }
}

function persistExecutionIdentityAdmissionEnvelope(
  envelope: ExecutionIdentityAdmissionEnvelope,
  options: Parameters<typeof processExecutionIdentityAdmissionWork>[1] = {},
) {
  return processExecutionIdentityAdmissionWork({ kind: "capture", envelope }, options);
}

function prepareExecutionIdentityContextAtAdmission(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  options: {
    database?: OpenClawStateDatabase;
    env?: NodeJS.ProcessEnv;
    now?: number;
    contextId?: string;
    executionId?: string;
    runtimeInstanceId?: string;
    limits?: { maxRows: number; pruneBatchRows: number };
  } = {},
) {
  const { contextId, executionId, runtimeInstanceId, now, limits, ...database } = options;
  const envelope = captureExecutionIdentityAdmissionEnvelope(admissionFacts, {
    ...(contextId !== undefined ? { contextId } : {}),
    ...(executionId !== undefined ? { executionId } : {}),
    ...(runtimeInstanceId !== undefined ? { runtimeInstanceId } : {}),
    ...(now !== undefined ? { now } : {}),
  });
  return persistExecutionIdentityAdmissionEnvelope(envelope, {
    ...database,
    ...(now !== undefined ? { now } : {}),
    ...(limits !== undefined ? { limits } : {}),
  });
}

function recordDeniedApprovalForRun(
  runId: string,
  database: ReturnType<typeof databaseOptions>,
  id = "denied-approval",
  binding?: { contextId: string; executionId: string },
): void {
  insertOperatorApproval({
    approval: {
      id,
      kind: "exec",
      presentation: {
        kind: "exec",
        commandText: "details withheld",
        allowedDecisions: ["allow-once", "deny"],
      },
      source: { runId, toolCallId: "private-tool-call", toolName: "exec" },
      runtimeEpoch: "runtime-1",
      createdAtMs: 100,
      expiresAtMs: 1_000,
      ...(binding
        ? {
            executionIdentityToken: {
              tokenVersion: 1,
              createdAt: 100,
              runId,
              contextId: binding.contextId,
              executionId: binding.executionId,
            },
          }
        : {}),
    },
    databaseOptions: database,
  });
  resolveOperatorApproval({
    id,
    decision: "deny",
    resolver: { kind: "device", id: "private-reviewer-device" },
    nowMs: 200,
    databaseOptions: database,
  });
}

describe("execution identity context storage", () => {
  it("replays one byte-identical canonical context idempotently across restart", () => {
    const database = databaseOptions();
    const envelope = captureExecutionIdentityAdmissionEnvelope(facts("run-1"), {
      now: 100,
      contextId: "context-1",
      executionId: "execution-1",
      runtimeInstanceId: "runtime-secret-1",
    });
    const first = persistExecutionIdentityAdmissionEnvelope(envelope, { ...database, now: 100 });

    closeOpenClawStateDatabaseForTest();
    const second = persistExecutionIdentityAdmissionEnvelope(structuredClone(envelope), {
      ...database,
      now: 999,
    });

    expect(second).toEqual(first);
    expect(first.coverageState).toBe("unattributed");
    expect(first.invoker).toEqual({ state: "absent" });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runtimeInstance)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("runtime-secret-1");

    closeOpenClawStateDatabaseForTest();
    const afterRestart = inspectExecutionIdentityRun(
      { executionId: "execution-1" },
      {
        ...database,
        now: 999,
      },
    );
    expect(afterRestart.identity).toEqual({ state: "present", context: first });
  });

  it("keeps explicit unknown invoker evidence distinct from omission across restart", () => {
    const database = databaseOptions();
    const unknown = prepareExecutionIdentityContextAtAdmission(
      facts("run-unknown", { invoker: { state: "unknown" } }),
      {
        ...database,
        now: 100,
        contextId: "context-unknown",
        executionId: "execution-unknown",
        runtimeInstanceId: "runtime-unknown",
      },
    );
    const absent = prepareExecutionIdentityContextAtAdmission(facts("run-absent"), {
      ...database,
      now: 101,
      contextId: "context-absent",
      executionId: "execution-absent",
      runtimeInstanceId: "runtime-absent",
    });

    expect(unknown).toMatchObject({
      invoker: { state: "unknown" },
      coverageState: "unknown",
      missingEvidence: ["invoker.principal"],
    });
    expect(unknown.invoker).not.toHaveProperty("principal");
    expect(absent).toMatchObject({
      invoker: { state: "absent" },
      coverageState: "unattributed",
      missingEvidence: ["invoker.principal"],
    });

    closeOpenClawStateDatabaseForTest();
    const unknownAfterRestart = inspectExecutionIdentityRun(
      { executionId: "execution-unknown" },
      { ...database, now: 101 },
    );
    expect(unknownAfterRestart.identity).toEqual({ state: "present", context: unknown });
    expect(unknownAfterRestart.coverage).toEqual({
      state: "unknown",
      missingEvidence: ["invoker.principal"],
    });
    expect(unknownAfterRestart.decisions).toEqual([
      expect.objectContaining({
        enforcement: expect.objectContaining({ coverageState: "unknown" }),
        missingEvidence: ["invoker.principal"],
      }),
    ]);
    expect(
      inspectExecutionIdentityRun({ executionId: "execution-absent" }, { ...database, now: 101 })
        .identity,
    ).toEqual({ state: "present", context: absent });
  });

  it.each([
    {
      difference: "contextId",
      mutate: (envelope: ExecutionIdentityAdmissionEnvelope) => ({
        ...envelope,
        contextId: "context-conflicting",
      }),
    },
    {
      difference: "createdAt",
      mutate: (envelope: ExecutionIdentityAdmissionEnvelope) => ({
        ...envelope,
        createdAt: envelope.createdAt + 1,
      }),
    },
    {
      difference: "identity facts",
      mutate: (envelope: ExecutionIdentityAdmissionEnvelope) => ({
        ...envelope,
        agentId: "other",
      }),
    },
  ])(
    "conflicts on a same-execution $difference and leaves canonical bytes unchanged",
    ({ mutate }) => {
      const database = databaseOptions();
      const envelope = captureExecutionIdentityAdmissionEnvelope(facts("run-conflict"), {
        contextId: "context-original",
        executionId: "execution-original",
        now: 100,
        runtimeInstanceId: "runtime-1",
      });
      const original = persistExecutionIdentityAdmissionEnvelope(envelope, {
        ...database,
        now: 100,
      });
      const originalRow = openOpenClawStateDatabase(database)
        .db.prepare("SELECT context_json FROM execution_identity_contexts WHERE execution_id = ?")
        .get("execution-original");

      expect(() =>
        persistExecutionIdentityAdmissionEnvelope(mutate(envelope), { ...database, now: 101 }),
      ).toThrow("execution identity context conflict");
      expect(
        openOpenClawStateDatabase(database)
          .db.prepare("SELECT context_json FROM execution_identity_contexts WHERE execution_id = ?")
          .get("execution-original"),
      ).toEqual(originalRow);
      expect(
        inspectExecutionIdentityRun(
          { executionId: "execution-original" },
          { ...database, now: 101 },
        ).identity,
      ).toEqual({ state: "present", context: original });
    },
  );

  it("keeps distinct turns sharing one run correlation exactly inspectable", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("session-run"), {
      ...database,
      now: 100,
      contextId: "context-first",
      executionId: "execution-first",
      runtimeInstanceId: "runtime-1",
    });
    prepareExecutionIdentityContextAtAdmission(facts("session-run"), {
      ...database,
      now: 101,
      contextId: "context-second",
      executionId: "execution-second",
      runtimeInstanceId: "runtime-1",
    });
    recordDeniedApprovalForRun("session-run", database, "shared-run-approval", {
      contextId: "context-first",
      executionId: "execution-first",
    });

    const discovery = inspectExecutionIdentityRun(
      { runId: "session-run" },
      { ...database, now: 300 },
    );
    expect(discovery).toMatchObject({
      run: { runId: "session-run", status: "known" },
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates: [
          { executionId: "execution-first", contextId: "context-first" },
          { executionId: "execution-second", contextId: "context-second" },
        ],
      },
      decisions: [],
    });
    for (const [executionOffset, executionId, nextExecutionCursor] of [
      [0, "execution-first", "1"],
      [1, "execution-second", undefined],
    ] as const) {
      expect(
        inspectExecutionIdentityRun(
          { runId: "session-run", executionOffset, executionLimit: 1 },
          { ...database, now: 300 },
        ),
      ).toMatchObject({
        identity: { state: "ambiguous", candidates: [{ executionId }] },
        ...(nextExecutionCursor ? { nextExecutionCursor } : {}),
      });
    }
    const firstInspection = inspectExecutionIdentityRun(
      { executionId: "execution-first" },
      { ...database, now: 300 },
    );
    const secondInspection = inspectExecutionIdentityRun(
      { executionId: "execution-second" },
      { ...database, now: 300 },
    );
    expect(firstInspection).toMatchObject({
      identity: { state: "present", context: { contextId: "context-first" } },
      coverage: { state: "enforced" },
      decisions: [{ decision: { outcome: "not-applicable" } }, { decision: { outcome: "denied" } }],
    });
    expect(secondInspection).toMatchObject({
      identity: { state: "present", context: { contextId: "context-second" } },
      coverage: {
        state: "unknown",
        missingEvidence: expect.arrayContaining(["decision.execution_link"]),
      },
      decisions: [
        { decision: { outcome: "not-applicable" } },
        {
          decision: {
            outcome: "unknown",
            reasonCode: "operator_approval_execution_link_mismatch",
          },
        },
      ],
    });
  });

  it("confirms durable retries without manufacturing lost evidence", () => {
    const database = databaseOptions();
    const envelope = captureExecutionIdentityAdmissionEnvelope(facts("run-recovery"), {
      now: 100,
      contextId: "context-recovery",
      executionId: "execution-recovery",
      runtimeInstanceId: "runtime-original",
    });
    const original = processExecutionIdentityAdmissionWork(
      { kind: "capture", envelope },
      { ...database, now: 100 },
    );
    const token = createExecutionIdentityAdmissionToken("run-recovery", {
      now: 100,
      contextId: "context-recovery",
      executionId: "execution-recovery",
    });

    closeOpenClawStateDatabaseForTest();
    expect(
      processExecutionIdentityAdmissionWork({ kind: "retry-reference", token }, database),
    ).toEqual(original);

    const missingDatabase = databaseOptions();
    expect(() =>
      processExecutionIdentityAdmissionWork({ kind: "retry-reference", token }, missingDatabase),
    ).toThrow("execution identity recovery evidence unavailable");
    expect(
      inspectExecutionIdentityRun({ executionId: "execution-recovery" }, missingDatabase),
    ).toMatchObject({
      run: { executionId: "execution-recovery", status: "unknown" },
      identity: { state: "unknown", reasonCode: "execution_not_found" },
      decisions: [],
    });
  });

  it("projects authoritative local CLI and system ingress without conflating them", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-local"), database);
    prepareExecutionIdentityContextAtAdmission(
      facts("run-system", {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      }),
      database,
    );

    expect(inspectExecutionIdentityRun({ runId: "run-local" }, database).identity).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      },
    });
    expect(inspectExecutionIdentityRun({ runId: "run-system" }, database).identity).toMatchObject({
      state: "present",
      context: {
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
      },
    });
  });

  it("keeps inspection read-only and lets persistence create the additive table", () => {
    const database = databaseOptions();
    const reopened = openOpenClawStateDatabase(database);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
    expect(inspectExecutionIdentityRun({ runId: "missing" }, database)).toMatchObject({
      run: { status: "unknown" },
      identity: { state: "unknown", reasonCode: "run_not_found" },
    });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();

    prepareExecutionIdentityContextAtAdmission(facts("schema-restored"), database);
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toEqual({ name: "execution_identity_contexts" });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("execution_identity_contexts_run_created_idx"),
    ).toEqual({ name: "execution_identity_contexts_run_created_idx" });
  });

  it("keeps maintenance read-only until the first identity capture", () => {
    const database = databaseOptions();
    const opened = openOpenClawStateDatabase(database);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();

    expect(pruneExpiredExecutionIdentityContexts({ database })).toBe(0);
    expect(
      opened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
  });

  it("records attribution only when an invoker fact is actually present", () => {
    const database = databaseOptions();
    const context = prepareExecutionIdentityContextAtAdmission(
      facts("run-attributed", {
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "private-local-account",
          displayLabel: "Operator OPENAI_API_KEY=sk-1234567890abcdef",
        },
        applicableGrants: [
          { rawGrantRef: "grant-z", state: "present" },
          { rawGrantRef: "grant-a", state: "present" },
        ],
        assurance: [
          {
            kind: "local-process",
            rawEvidenceRef: "private-process-evidence",
            strength: "boundary-verified",
          },
        ],
      }),
      { ...database, runtimeInstanceId: "private-runtime" },
    );
    const encoded = JSON.stringify(context);

    expect(context.coverageState).toBe("attribution-only");
    expect(context.invoker.state).toBe("present");
    expect(context.missingEvidence).toEqual([]);
    expect(context.applicableGrants.map((grant) => grant.grantRef)).toEqual(
      context.applicableGrants.map((grant) => grant.grantRef).toSorted(),
    );
    for (const secret of [
      "private-local-account",
      "private-process-evidence",
      "private-runtime",
      "grant-a",
      "grant-z",
      "sk-1234567890abcdef",
    ]) {
      expect(encoded).not.toContain(secret);
    }
    expect(context.invoker.principal?.principalRef).toMatch(/^hmac-sha256:v1:/u);
  });

  it("declines recording instead of rotating a missing HMAC key with retained contexts", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-before-key-loss"), database);
    openOpenClawStateDatabase(database).db.exec("DELETE FROM audit_identity_keys;");
    closeOpenClawStateDatabaseForTest();

    expect(() =>
      prepareExecutionIdentityContextAtAdmission(facts("run-after-key-loss"), database),
    ).toThrow("audit identity key is missing");
  });

  it("skips new context rows when audit collection is disabled", () => {
    const database = databaseOptions();

    expect(
      enqueueExecutionIdentityContextAtAdmission(facts("run-disabled"), { enabled: false }),
    ).toBeUndefined();

    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
  });

  it("keeps bounded retention maintenance available while collection is disabled", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-before-disable"), {
      ...database,
      now: 0,
      runtimeInstanceId: "runtime-1",
    });
    expect(
      enqueueExecutionIdentityContextAtAdmission(facts("run-disabled"), { enabled: false }),
    ).toBeUndefined();

    expect(pruneExpiredExecutionIdentityContexts({ database, now: RETENTION_MS + 1 })).toBe(1);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("leaves the original context intact when a later worker write conflicts", () => {
    const database = databaseOptions();
    const envelope = captureExecutionIdentityAdmissionEnvelope(facts("run-best-effort"), {
      contextId: "context-best-effort",
      executionId: "execution-best-effort",
      runtimeInstanceId: "runtime-1",
    });
    persistExecutionIdentityAdmissionEnvelope(envelope, database);

    expect(() =>
      persistExecutionIdentityAdmissionEnvelope(
        { ...envelope, agentId: "conflicting-agent" },
        database,
      ),
    ).toThrow("execution identity context conflict");
  });

  it("rolls back the worker write when insert-time retention cleanup fails", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-expired"), {
      ...database,
      now: 0,
      runtimeInstanceId: "runtime-1",
    });
    openOpenClawStateDatabase(database).db.exec(`
      CREATE TRIGGER reject_identity_cleanup
      BEFORE DELETE ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'cleanup unavailable');
      END;
    `);

    expect(() =>
      prepareExecutionIdentityContextAtAdmission(facts("run-still-admitted"), {
        ...database,
        now: RETENTION_MS + 1,
        runtimeInstanceId: "runtime-1",
      }),
    ).toThrow("cleanup unavailable");
  });

  it("stops projecting context and decisions immediately after the retention boundary", () => {
    const database = databaseOptions();
    const createdAt = 1_000;
    prepareExecutionIdentityContextAtAdmission(facts("run-retention"), {
      ...database,
      now: createdAt,
      contextId: "expired-context-secret",
      executionId: "expired-execution-secret",
      runtimeInstanceId: "expired-runtime-secret",
    });

    const immediatelyBefore = inspectExecutionIdentityRun(
      { runId: "run-retention" },
      { ...database, now: createdAt + RETENTION_MS - 1 },
    );
    expect(immediatelyBefore.identity).toMatchObject({
      state: "present",
      context: { contextId: "expired-context-secret" },
    });
    expect(immediatelyBefore.decisions).toHaveLength(1);
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-retention" },
        { ...database, now: createdAt + RETENTION_MS },
      ).identity.state,
    ).toBe("present");

    const immediatelyAfter = inspectExecutionIdentityRun(
      { runId: "run-retention" },
      { ...database, now: createdAt + RETENTION_MS + 1 },
    );
    expect(immediatelyAfter).toMatchObject({
      run: { status: "known" },
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        remediation: [
          expect.objectContaining({
            code: "run_again_after_expiry",
            text: expect.stringContaining("outside the 30-day window"),
          }),
        ],
      },
      decisions: [],
      coverage: { state: "unsupported", missingEvidence: ["identity.context"] },
    });
    expect(JSON.stringify(immediatelyAfter)).not.toContain("expired-context-secret");
    expect(JSON.stringify(immediatelyAfter)).not.toContain("expired-runtime-secret");
    expect(JSON.stringify(immediatelyAfter)).not.toContain("run_admission_identity_not_evaluated");
    const exactAfter = inspectExecutionIdentityRun(
      { executionId: "expired-execution-secret" },
      { ...database, now: createdAt + RETENTION_MS + 1 },
    );
    expect(exactAfter).toMatchObject({
      run: { executionId: "expired-execution-secret", status: "known" },
      identity: { state: "unsupported", reasonCode: "identity_context_unavailable" },
      decisions: [],
    });
    expect(JSON.stringify(exactAfter)).not.toContain("expired-context-secret");
    expect(JSON.stringify(exactAfter)).not.toContain("expired-runtime-secret");

    closeOpenClawStateDatabaseForTest();
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-retention" },
        { ...database, now: createdAt + RETENTION_MS + 1 },
      ),
    ).toEqual(immediatelyAfter);

    expect(
      pruneExpiredExecutionIdentityContexts({
        database,
        now: createdAt + RETENTION_MS + 1,
      }),
    ).toBe(1);
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-retention" },
        { ...database, now: createdAt + RETENTION_MS + 1 },
      ),
    ).toMatchObject({
      run: { status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        remediation: [
          expect.objectContaining({ text: expect.stringContaining("not proof of no run") }),
        ],
      },
      decisions: [],
    });
  });

  it("prunes expired contexts in bounded maintenance batches without new inserts", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("schema-seed"), {
      ...database,
      now: 1,
      runtimeInstanceId: "runtime-1",
    });
    const { db } = openOpenClawStateDatabase(database);
    db.exec("DELETE FROM execution_identity_contexts;");
    db.prepare(
      `WITH RECURSIVE rows(n) AS (
         VALUES (1)
         UNION ALL
         SELECT n + 1 FROM rows WHERE n < 1025
       )
       INSERT INTO execution_identity_contexts (
         context_id, execution_id, run_id, created_at, coverage_state, context_bytes, context_json
       )
       SELECT 'context-' || n, 'execution-' || n, 'run-' || n, 0, 'unattributed', 2, '{}'
       FROM rows`,
    ).run();

    expect(pruneExpiredExecutionIdentityContexts({ database, now: RETENTION_MS + 1 })).toBe(1_024);
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get()).toEqual({
      count: 1,
    });
    expect(pruneExpiredExecutionIdentityContexts({ database, now: RETENTION_MS + 1 })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get()).toEqual({
      count: 0,
    });
  });

  it("prunes retention and row-cap overflow in bounded batches", () => {
    const retentionDatabase = databaseOptions();
    for (const runId of ["old-1", "old-2", "old-3"]) {
      prepareExecutionIdentityContextAtAdmission(facts(runId), {
        ...retentionDatabase,
        now: 0,
        runtimeInstanceId: "runtime-1",
        limits: { maxRows: 10, pruneBatchRows: 1 },
      });
    }
    prepareExecutionIdentityContextAtAdmission(facts("new-1"), {
      ...retentionDatabase,
      now: RETENTION_MS + 1,
      runtimeInstanceId: "runtime-1",
      limits: { maxRows: 1, pruneBatchRows: 1 },
    });
    const retainedAfterOneBatch = openOpenClawStateDatabase(retentionDatabase)
      .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
      .get() as { count: number };
    expect(retainedAfterOneBatch.count).toBe(3);

    const capDatabase = databaseOptions();
    for (const runId of ["cap-1", "cap-2", "cap-3"]) {
      prepareExecutionIdentityContextAtAdmission(facts(runId), {
        ...capDatabase,
        now: 100,
        contextId: `context-${runId}`,
        runtimeInstanceId: "runtime-1",
        limits: { maxRows: 2, pruneBatchRows: 1 },
      });
    }
    const capped = openOpenClawStateDatabase(capDatabase)
      .db.prepare("SELECT run_id FROM execution_identity_contexts ORDER BY context_id")
      .all() as Array<{ run_id: string }>;
    expect(capped).toHaveLength(2);
    expect(capped.map((row) => row.run_id)).not.toContain("cap-1");
  });

  it("enforces the row cap across independent database connections", () => {
    const database = databaseOptions();
    const path = openOpenClawStateDatabase(database).path;
    closeOpenClawStateDatabaseForTest();
    const first = openIndependentStateDatabase(path);
    const second = openIndependentStateDatabase(path);
    try {
      for (const [index, connection] of [first, second, first, second].entries()) {
        const runId = `shared-cap-${index + 1}`;
        prepareExecutionIdentityContextAtAdmission(facts(runId), {
          database: connection,
          now: 100 + index,
          contextId: `context-${runId}`,
          runtimeInstanceId: "runtime-1",
          limits: { maxRows: 2, pruneBatchRows: 1 },
        });
      }

      const retained = first.db
        .prepare("SELECT run_id FROM execution_identity_contexts ORDER BY created_at")
        .all() as Array<{ run_id: string }>;
      expect(retained.map((row) => row.run_id)).toEqual(["shared-cap-3", "shared-cap-4"]);
    } finally {
      first.db.close();
      second.db.close();
    }
  });

  it("inspects through a read-only connection while another writer holds the database", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("held-lock-inspection"), {
      ...database,
      now: 100,
      contextId: "context-held-lock-inspection",
      executionId: "execution-held-lock-inspection",
      runtimeInstanceId: "runtime-1",
    });
    const path = openOpenClawStateDatabase(database).path;
    closeOpenClawStateDatabaseForTest();
    const lockDatabase = openNodeSqliteDatabase(path);
    lockDatabase.exec("BEGIN IMMEDIATE");
    try {
      const startedAt = performance.now();
      expect(
        inspectExecutionIdentityRun(
          { executionId: "execution-held-lock-inspection" },
          { ...database, now: 100 },
        ),
      ).toMatchObject({
        identity: {
          state: "present",
          context: {
            contextId: "context-held-lock-inspection",
            executionId: "execution-held-lock-inspection",
            runId: "held-lock-inspection",
          },
        },
      });
      expect(performance.now() - startedAt).toBeLessThan(250);
    } finally {
      lockDatabase.exec("ROLLBACK");
      lockDatabase.close();
    }
  });

  it("returns typed corrupt, unknown, and unsupported projections", () => {
    const corruptDatabase = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-corrupt"), {
      ...corruptDatabase,
      runtimeInstanceId: "runtime-1",
    });
    openOpenClawStateDatabase(corruptDatabase)
      .db.prepare("UPDATE execution_identity_contexts SET context_json = ? WHERE run_id = ?")
      .run("{", "run-corrupt");
    expect(inspectExecutionIdentityRun({ runId: "run-corrupt" }, corruptDatabase)).toMatchObject({
      run: { status: "known" },
      identity: { state: "unknown", reasonCode: "identity_context_corrupt" },
      coverage: { state: "unknown" },
    });

    const unknownDatabase = databaseOptions();
    expect(inspectExecutionIdentityRun({ runId: "never-seen" }, unknownDatabase)).toMatchObject({
      run: { status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        remediation: [expect.objectContaining({ code: "verify_run_id" })],
      },
    });

    recordAuditEvent(
      {
        sourceId: "legacy-run:1",
        sourceSequence: 1,
        occurredAt: Date.now(),
        kind: "agent_run",
        action: "agent.run.started",
        status: "started",
        actorType: "agent",
        actorId: "main",
        agentId: "main",
        runId: "legacy-run",
      },
      unknownDatabase,
    );
    expect(inspectExecutionIdentityRun({ runId: "legacy-run" }, unknownDatabase)).toMatchObject({
      run: { status: "known" },
      identity: {
        state: "unsupported",
        reasonCode: "identity_context_unavailable",
        remediation: [expect.objectContaining({ code: "record_new_identity_context" })],
      },
    });
  });

  it("projects one non-enforcement admission explanation", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-receipt"), {
      ...database,
      now: 123,
      contextId: "context-receipt",
      runtimeInstanceId: "runtime-1",
    });
    const result = inspectExecutionIdentityRun({ runId: "run-receipt" }, { ...database, now: 123 });

    expect(result.identity).toMatchObject({
      state: "present",
      context: { contextId: "context-receipt", coverageState: "unattributed" },
    });
    expect(result.decisions).toEqual([
      expect.objectContaining({
        decision: {
          outcome: "not-applicable",
          reasonCode: "run_admission_identity_not_evaluated",
        },
        enforcement: expect.objectContaining({
          coverageState: "unattributed",
          policyRefs: [],
          grantRefs: [],
          contextFieldsUsed: [],
        }),
      }),
    ]);
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-receipt", decisionLimit: 1 },
        { ...database, now: 123 },
      ).nextDecisionCursor,
    ).toBeUndefined();
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-receipt", decisionCursor: "a:0:0" },
        { ...database, now: 123 },
      ).decisions,
    ).toEqual([]);
  });

  it("projects an authoritative denied approval by run before and after restart", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-denied-receipt"), {
      ...database,
      now: 100,
      contextId: "context-denied-receipt",
      executionId: "execution-denied-receipt",
      runtimeInstanceId: "runtime-1",
    });
    recordDeniedApprovalForRun("run-denied-receipt", database, "denied-approval", {
      contextId: "context-denied-receipt",
      executionId: "execution-denied-receipt",
    });

    const beforeRestart = inspectExecutionIdentityRun(
      { runId: "run-denied-receipt" },
      { ...database, now: 300 },
    );
    expect(beforeRestart).toMatchObject({
      coverage: { state: "enforced" },
      decisions: [
        { decision: { outcome: "not-applicable" } },
        {
          contextId: "context-denied-receipt",
          executionId: "execution-denied-receipt",
          runId: "run-denied-receipt",
          decision: {
            outcome: "denied",
            reasonCode: "operator_approval_denied_by_reviewer",
          },
          enforcement: {
            coverageState: "enforced",
            contextFieldsUsed: ["contextId", "executionId", "runId"],
          },
          source: { owner: "operator_approvals" },
        },
      ],
    });
    expect(JSON.stringify(beforeRestart)).not.toContain("private-reviewer-device");
    expect(JSON.stringify(beforeRestart)).not.toContain("private-tool-call");

    closeOpenClawStateDatabaseForTest();
    expect(
      inspectExecutionIdentityRun({ runId: "run-denied-receipt" }, { ...database, now: 300 }),
    ).toEqual(beforeRestart);
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-denied-receipt", decisionCursor: "a:0:0", decisionLimit: 1 },
        { ...database, now: 300 },
      ),
    ).toMatchObject({
      decisions: [{ decision: { reasonCode: "operator_approval_denied_by_reviewer" } }],
    });
    expect(
      inspectExecutionIdentityRun(
        { runId: "run-denied-receipt", decisionCursor: "1", decisionLimit: 1 },
        { ...database, now: 300 },
      ).decisions,
    ).toMatchObject([{ decision: { reasonCode: "operator_approval_denied_by_reviewer" } }]);
  });

  it("keeps a corrupt approval unknown before its decision page is returned", () => {
    const database = databaseOptions();
    prepareExecutionIdentityContextAtAdmission(facts("run-corrupt-approval"), {
      ...database,
      now: 100,
      contextId: "context-corrupt-approval",
      executionId: "execution-corrupt-approval",
      runtimeInstanceId: "runtime-1",
    });
    recordDeniedApprovalForRun("run-corrupt-approval", database, "corrupt-approval", {
      contextId: "context-corrupt-approval",
      executionId: "execution-corrupt-approval",
    });
    openOpenClawStateDatabase(database)
      .db.prepare("UPDATE operator_approvals SET presentation_json = ? WHERE approval_id = ?")
      .run("{", "corrupt-approval");

    expect(
      inspectExecutionIdentityRun(
        { executionId: "execution-corrupt-approval", decisionLimit: 1 },
        { ...database, now: 300 },
      ),
    ).toMatchObject({
      coverage: {
        state: "unknown",
        missingEvidence: expect.arrayContaining(["operator_approval.valid"]),
      },
      decisions: [{ decision: { outcome: "not-applicable" } }],
      nextDecisionCursor: "a:0:0",
    });
  });

  it("reports a retained approval with no identity context as an unknown missing link", () => {
    const database = databaseOptions();
    recordDeniedApprovalForRun("run-missing-context", database);

    expect(
      inspectExecutionIdentityRun({ runId: "run-missing-context" }, { ...database, now: 300 }),
    ).toMatchObject({
      run: { runId: "run-missing-context", status: "known" },
      identity: {
        state: "unknown",
        reasonCode: "decision_context_link_missing",
      },
      decisions: [],
      coverage: {
        state: "unknown",
        missingEvidence: ["identity.context", "decision.context_link"],
      },
    });
  });
});
