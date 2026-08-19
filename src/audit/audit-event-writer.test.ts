import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listAuditEvents, recordAuditEvent } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import { createAuditEventRecorder } from "./audit-recorder.js";
import { pageExecutionDecisionFactsForContext } from "./execution-decision-facts.js";
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
} from "./execution-identity-context.js";
import type { TrustedMessageAuditEvent } from "./message-audit-events.js";

function defineObjectPrototypeProperties(descriptors: PropertyDescriptorMap): void {
  // oxlint-disable-next-line no-extend-native -- Exercise hostile prototype pollution across the real clone boundary.
  Object.defineProperties(Object.prototype, descriptors);
}

function captureExecutionIdentityAdmissionEnvelope(
  facts: ExecutionIdentityAdmissionFacts,
  options: {
    contextId?: string;
    executionId?: string;
    now?: number;
    runtimeInstanceId?: string;
  } = {},
) {
  let captured: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((work) => {
    if (work.kind === "capture") {
      captured = work.envelope;
    }
    return true;
  });
  const result = enqueueExecutionIdentityContextAtAdmission(facts, {
    ...options,
    enabled: true,
  });
  clear();
  if (!result || !captured) {
    throw new Error("expected admission envelope");
  }
  return captured;
}

function persistExecutionIdentityAdmissionEnvelope(
  envelope: ExecutionIdentityAdmissionEnvelope,
  options: Parameters<typeof processExecutionIdentityAdmissionWork>[1] = {},
) {
  return processExecutionIdentityAdmissionWork({ kind: "capture", envelope }, options);
}

function input(): AuditEventInput {
  return {
    sourceId: "run-1:1:started",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-1",
  };
}

function messageEvent(
  action:
    | "message.outbound.queued"
    | "message.outbound.platform-started"
    | "message.outbound.finished",
): TrustedMessageAuditEvent {
  const progress = action !== "message.outbound.finished";
  return {
    sourceId: `message-source:${action}`,
    occurredAt: Date.now(),
    kind: "message",
    action,
    status: progress ? "started" : "succeeded",
    outcome:
      action === "message.outbound.queued"
        ? "queued"
        : action === "message.outbound.platform-started"
          ? "platform_started"
          : "sent",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "message-worker-run",
    direction: "outbound",
    channel: "qa-channel",
    conversationKind: "direct",
    targetId: "raw-target",
  } as TrustedMessageAuditEvent;
}

function decisionReceipt(): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: "worker-decision",
    contextId: "worker-context",
    executionId: "worker-execution",
    runId: "worker-run",
    occurredAt: Date.now(),
    action: { family: "tool", operation: "policy" },
    decision: { outcome: "denied", reasonCode: "tool_policy_denied" },
    enforcement: {
      coverageState: "enforced",
      policyRefs: ["tool-policy:deny"],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "tool-policy",
      recordRef: "worker-record",
      decisionBoundary: "agent-tool.before-call",
    },
    missingEvidence: [],
    remediation: [{ code: "choose_allowed_tool", text: "Choose an allowed tool and retry." }],
  };
}

function captureWork(envelope: ExecutionIdentityAdmissionEnvelope) {
  return { kind: "capture" as const, envelope };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("audit event writer", () => {
  it("keeps progress absent while disabled and routes enabled progress off audit_events", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const disabledWriter = createAuditEventWriter({ stateDir });
    const disabledRecorder = createAuditEventRecorder({
      messageMode: "off",
      writer: disabledWriter,
    });
    await disabledWriter.ready;
    expect(tableExists(openOpenClawStateDatabase(database).db, "outbound_message_progress")).toBe(
      false,
    );
    disabledRecorder.recordMessage(messageEvent("message.outbound.queued"));
    await disabledWriter.stop();
    expect(tableExists(openOpenClawStateDatabase(database).db, "outbound_message_progress")).toBe(
      false,
    );

    const enabledWriter = createAuditEventWriter({ stateDir });
    const enabledRecorder = createAuditEventRecorder({
      messageMode: "all",
      writer: enabledWriter,
    });
    enabledRecorder.recordMessage(messageEvent("message.outbound.queued"));
    enabledRecorder.recordMessage(messageEvent("message.outbound.platform-started"));
    enabledRecorder.recordMessage(messageEvent("message.outbound.finished"));
    await enabledWriter.ready;
    await enabledWriter.stop();

    const { db } = openOpenClawStateDatabase(database);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS count FROM outbound_message_progress").get() as {
          count: number;
        }
      ).count,
    ).toBe(2);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
    ).toBe(1);
    expect(
      (
        db.prepare("SELECT action FROM audit_events").get() as {
          action: string;
        }
      ).action,
    ).toBe("message.outbound.finished");
  });

  it("flushes accepted events through the canonical state connection", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const owner = openOpenClawStateDatabase(database).db;
    const readDataVersion = () =>
      (owner.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    const dataVersionBefore = readDataVersion();
    const writer = createAuditEventWriter({ stateDir });

    await writer.ready;
    expect(writer.record(input())).toBe(true);
    await writer.stop();

    expect(readDataVersion()).toBe(dataVersionBefore);
    expect(owner.prepare("SELECT run_id FROM audit_events").get()).toEqual({ run_id: "run-1" });
    expect(owner.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
  });

  it("keeps fresh storage identity-free when recovery evidence is missing", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });

    await writer.ready;
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
    expect(writer.record(input())).toBe(true);
    const token = createExecutionIdentityAdmissionToken("raw-run-not-a-secret", {
      contextId: "context-missing",
      executionId: "execution-missing",
      now: 100,
    });
    const startedAt = performance.now();
    expect(writer.recordExecutionIdentity({ kind: "retry-reference", token })).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(250);
    await writer.stop();

    expect(errors).toEqual(["audit execution identity recovery evidence unavailable"]);
    expect(JSON.stringify(errors)).not.toContain(token.contextId);
    expect(JSON.stringify(errors)).not.toContain(token.executionId);
    expect(JSON.stringify(errors)).not.toContain(token.runId);
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(1);
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_decision_facts"),
    ).toBeUndefined();
  });

  it("keeps a cold owner open nonblocking under a held write lock", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    recordAuditEvent(input(), database);
    const path = openOpenClawStateDatabase(database).path;
    closeOpenClawStateDatabaseForTest();
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const errors: string[] = [];
    const probeStartedAt = performance.now();
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });

    try {
      const eventLoopDelay = await new Promise<number>((resolve) => {
        setTimeout(() => resolve(performance.now() - probeStartedAt), 25);
      });
      expect(eventLoopDelay).toBeLessThan(250);
      await writer.ready;
      expect(writer.record({ ...input(), sourceId: "cold-owner", runId: "cold-owner" })).toBe(true);
    } finally {
      contender.exec("ROLLBACK");
      contender.close();
      await writer.stop();
    }

    expect(errors).toEqual([]);
    expect(listAuditEvents({ database, limit: 10 }).events.map((event) => event.runId)).toContain(
      "cold-owner",
    );
  });

  it("persists a generic decision through the bounded queue", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });

    await writer.ready;
    const receipt = decisionReceipt();
    const envelope = captureExecutionIdentityAdmissionEnvelope(
      {
        runId: receipt.runId,
        agentId: "main",
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
        runtime: { kind: "embedded" },
      },
      {
        contextId: receipt.contextId,
        executionId: receipt.executionId,
        runtimeInstanceId: "worker-runtime",
        now: receipt.occurredAt,
      },
    );
    expect(writer.recordExecutionIdentity(captureWork(envelope))).toBe(true);
    expect(writer.recordExecutionDecision(receipt)).toBe(true);
    await writer.stop();

    expect(errors).toEqual([]);
    expect(
      pageExecutionDecisionFactsForContext({
        context: receipt,
        limit: 10,
        now: receipt.occurredAt,
        database,
      }).receipts,
    ).toEqual([receipt]);
  });

  it("keeps the shared queue nonblocking under a held write lock and flushes before stop", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    recordAuditEvent(input(), database);
    closeOpenClawStateDatabaseForTest();
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      stateDir,
      maxPending: 2,
      onError: (error) => errors.push(error),
    });
    await writer.ready;
    const { db, path } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("execution_identity_contexts"),
    ).toBeUndefined();
    db.exec("DELETE FROM audit_identity_keys;");
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
    const admittedAt = Date.now();

    try {
      const startedAt = performance.now();
      expect(writer.record({ ...input(), sourceId: "run-2:1:started", runId: "run-2" })).toBe(true);
      expect(
        enqueueExecutionIdentityContextAtAdmission(
          {
            runId: "held-lock-run",
            agentId: "main",
            ingress: {
              kind: "local-cli",
              boundary: "agent-command.local",
              state: "present",
              rawSourceRef: "raw-ingress-secret",
            },
            runtime: { kind: "embedded" },
            invoker: {
              state: "present",
              kind: "local-account",
              rawPrincipalRef: "raw-principal-secret",
            },
          },
          {
            enabled: true,
            contextId: "held-lock-context",
            executionId: "held-lock-execution",
            now: admittedAt,
            runtimeInstanceId: "raw-runtime-secret",
          },
        ),
      ).toEqual({
        candidateContextId: "held-lock-context",
        candidateExecutionId: "held-lock-execution",
        accepted: true,
      });
      expect(performance.now() - startedAt).toBeLessThan(250);
      const eventLoopProbeStartedAt = performance.now();
      const eventLoopDelay = await new Promise<number>((resolve) => {
        setTimeout(() => resolve(performance.now() - eventLoopProbeStartedAt), 25);
      });
      expect(eventLoopDelay).toBeLessThan(250);
      expect(readSqliteBusyTimeout(db)).toBe(5_000);
      expect(
        writer.recordExecutionIdentity({
          kind: "retry-reference",
          token: createExecutionIdentityAdmissionToken("queue-full-run", {
            contextId: "queue-full-context",
            executionId: "queue-full-execution",
            now: admittedAt,
          }),
        }),
      ).toBe(false);
      expect(errors).toEqual(["audit event queue is full (2); dropping metadata"]);
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'execution_identity_contexts'")
          .get(),
      ).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS count FROM audit_identity_keys").get()).toEqual({
        count: 0,
      });
    } finally {
      try {
        contender.exec("ROLLBACK");
        contender.close();
      } finally {
        clearSink();
        await writer.stop();
      }
    }

    expect(errors).toEqual(["audit event queue is full (2); dropping metadata"]);
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(2);
    expect(
      inspectExecutionIdentityRun({ runId: "held-lock-run" }, { ...database, now: admittedAt }),
    ).toMatchObject({
      identity: {
        state: "present",
        context: {
          contextId: "held-lock-context",
          executionId: "held-lock-execution",
          runId: "held-lock-run",
          createdAt: admittedAt,
          ingress: {
            kind: "local-cli",
            boundary: "agent-command.local",
            state: "present",
          },
          runtimeInstance: { kind: "embedded", state: "present" },
        },
      },
    });
    const persisted = db
      .prepare("SELECT context_json FROM execution_identity_contexts WHERE run_id = ?")
      .get("held-lock-run") as { context_json: string };
    for (const raw of ["raw-ingress-secret", "raw-principal-secret", "raw-runtime-secret"]) {
      expect(persisted.context_json).not.toContain(raw);
      expect(JSON.stringify(errors)).not.toContain(raw);
    }
  });

  it("reports sustained lock contention once while backing off retries", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const contentions: string[] = [];
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      stateDir,
      onContention: (message) => contentions.push(message),
      onError: (error) => errors.push(error),
    });
    await writer.ready;
    const { path } = openOpenClawStateDatabase(database);
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    let fakeTimersActive = false;

    try {
      vi.useFakeTimers({
        toFake: ["setImmediate", "clearImmediate", "setTimeout", "clearTimeout"],
      });
      fakeTimersActive = true;
      expect(
        writer.record({
          ...input(),
          sourceId: "sustained-contention",
          runId: "sustained-contention",
        }),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(1_750);
      expect(contentions).toEqual(["audit event persistence delayed by SQLite lock contention"]);
    } finally {
      try {
        try {
          contender.exec("ROLLBACK");
        } finally {
          contender.close();
        }
      } finally {
        try {
          const stopPromise = writer.stop();
          if (fakeTimersActive) {
            await vi.advanceTimersToNextTimerAsync();
          }
          await stopPromise;
        } finally {
          if (fakeTimersActive) {
            vi.useRealTimers();
          }
        }
      }
    }

    expect(errors).toEqual([]);
    expect(listAuditEvents({ database, limit: 10 }).events.map((event) => event.runId)).toContain(
      "sustained-contention",
    );
  });

  it("persists owned unknown and omits inherited evidence through the queue clone boundary", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    const clearSink = configureExecutionIdentityAdmissionSink(writer.recordExecutionIdentity);
    const admittedAt = Date.now();
    const inheritedRefs = {
      invoker: "raw-inherited-principal",
      applicableGrants: "raw-inherited-grant",
      assurance: "raw-inherited-assurance",
      rawSourceRef: "raw-inherited-source",
    } as const;
    const prior = new Map(
      Object.keys(inheritedRefs).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(Object.prototype, key),
      ]),
    );
    let inheritedInvokerReads = 0;

    try {
      try {
        defineObjectPrototypeProperties({
          invoker: {
            configurable: true,
            enumerable: false,
            get: () => {
              inheritedInvokerReads += 1;
              return {
                state: "present",
                kind: "local-account",
                rawPrincipalRef: inheritedRefs.invoker,
              };
            },
          },
          applicableGrants: {
            configurable: true,
            enumerable: false,
            value: [{ rawGrantRef: inheritedRefs.applicableGrants, state: "present" }],
          },
          assurance: {
            configurable: true,
            enumerable: false,
            value: [
              {
                kind: "other",
                rawEvidenceRef: inheritedRefs.assurance,
                strength: "self-asserted",
              },
            ],
          },
          rawSourceRef: {
            configurable: true,
            enumerable: false,
            value: inheritedRefs.rawSourceRef,
          },
        });
        expect(
          enqueueExecutionIdentityContextAtAdmission(
            {
              runId: "absent-invoker-run",
              agentId: "main",
              ingress: {
                kind: "local-cli",
                boundary: "agent-command.local",
                state: "present",
              },
              runtime: { kind: "embedded" },
            },
            {
              enabled: true,
              contextId: "absent-invoker-context",
              executionId: "absent-invoker-execution",
              now: admittedAt,
              runtimeInstanceId: "private-absent-runtime-reference",
            },
          ),
        ).toEqual({
          candidateContextId: "absent-invoker-context",
          candidateExecutionId: "absent-invoker-execution",
          accepted: true,
        });
      } finally {
        for (const [key, descriptor] of prior) {
          if (descriptor) {
            defineObjectPrototypeProperties({ [key]: descriptor });
          } else {
            delete (Object.prototype as Record<string, unknown>)[key];
          }
        }
      }

      expect(
        enqueueExecutionIdentityContextAtAdmission(
          {
            runId: "unknown-invoker-run",
            agentId: "main",
            ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
            runtime: { kind: "embedded" },
            invoker: { state: "unknown" },
          },
          {
            enabled: true,
            contextId: "unknown-invoker-context",
            executionId: "unknown-invoker-execution",
            now: admittedAt + 1,
            runtimeInstanceId: "private-unknown-runtime-reference",
          },
        ),
      ).toEqual({
        candidateContextId: "unknown-invoker-context",
        candidateExecutionId: "unknown-invoker-execution",
        accepted: true,
      });
    } finally {
      clearSink();
      await writer.ready;
      await writer.stop();
    }

    const absentInspection = inspectExecutionIdentityRun(
      { executionId: "absent-invoker-execution" },
      { ...database, now: admittedAt + 1 },
    );
    const unknownInspection = inspectExecutionIdentityRun(
      { executionId: "unknown-invoker-execution" },
      { ...database, now: admittedAt + 1 },
    );
    expect(inheritedInvokerReads).toBe(0);
    expect(errors).toEqual([]);
    expect(absentInspection).toMatchObject({
      identity: {
        state: "present",
        context: {
          invoker: { state: "absent" },
          ingress: { state: "present" },
          applicableGrants: [],
          assurance: [{ kind: "runtime-binding", strength: "boundary-verified" }],
          coverageState: "unattributed",
          missingEvidence: ["invoker.principal"],
        },
      },
      coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
    });
    expect(unknownInspection).toMatchObject({
      identity: {
        state: "present",
        context: {
          invoker: { state: "unknown" },
          coverageState: "unknown",
          missingEvidence: ["invoker.principal"],
        },
      },
      coverage: { state: "unknown", missingEvidence: ["invoker.principal"] },
    });
    const persisted = openOpenClawStateDatabase(database)
      .db.prepare(
        "SELECT context_json FROM execution_identity_contexts WHERE execution_id IN (?, ?) ORDER BY execution_id",
      )
      .all("absent-invoker-execution", "unknown-invoker-execution") as Array<{
      context_json: string;
    }>;
    const publicAndStored = JSON.stringify({
      errors,
      absentInspection,
      unknownInspection,
      persisted,
    });
    for (const rawRef of Object.values(inheritedRefs)) {
      expect(publicAndStored).not.toContain(rawRef);
    }
    expect(publicAndStored).not.toContain("private-absent-runtime-reference");
    expect(publicAndStored).not.toContain("private-unknown-runtime-reference");
  });

  it("prunes expired identity contexts before preserving exact-envelope conflicts", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    persistExecutionIdentityAdmissionEnvelope(
      captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "expired-before-startup",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          runtime: { kind: "embedded" },
        },
        { now: 0, runtimeInstanceId: "runtime-1" },
      ),
      { ...database, now: 0 },
    );
    closeOpenClawStateDatabaseForTest();

    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    await writer.ready;
    expect(
      openOpenClawStateDatabase(database)
        .db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
        .get(),
    ).toEqual({ count: 0 });
    const admittedAt = Date.now();
    const original = captureExecutionIdentityAdmissionEnvelope(
      {
        runId: "ordered-run",
        agentId: "main",
        ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
        runtime: { kind: "embedded" },
      },
      {
        contextId: "ordered-context",
        executionId: "ordered-execution",
        now: admittedAt,
        runtimeInstanceId: "runtime-1",
      },
    );
    const factConflict = captureExecutionIdentityAdmissionEnvelope(
      {
        runId: "ordered-run",
        agentId: "other",
        ingress: {
          kind: "local-cli",
          boundary: "agent-command.local",
          state: "present",
          rawSourceRef: "raw-conflict-source",
        },
        runtime: { kind: "embedded" },
        invoker: {
          state: "present",
          kind: "local-account",
          rawPrincipalRef: "raw-conflict-principal",
        },
      },
      {
        contextId: "ordered-context",
        executionId: "ordered-execution",
        now: admittedAt,
        runtimeInstanceId: "runtime-1",
      },
    );
    const contextIdConflict = { ...original, contextId: "conflicting-context" };
    const createdAtConflict = { ...original, createdAt: admittedAt + 1 };

    const startedAt = performance.now();
    expect(writer.recordExecutionIdentity(captureWork(original))).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(original))).toBe(true);
    expect(
      writer.recordExecutionIdentity({
        kind: "retry-reference",
        token: createExecutionIdentityAdmissionToken(original.runId, {
          contextId: original.contextId,
          executionId: original.executionId,
          now: original.createdAt,
        }),
      }),
    ).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(contextIdConflict))).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(createdAtConflict))).toBe(true);
    expect(writer.recordExecutionIdentity(captureWork(factConflict))).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(250);
    await writer.stop();

    expect(errors).toEqual([
      "audit execution identity context conflict",
      "audit execution identity context conflict",
      "audit execution identity context conflict",
    ]);
    expect(
      inspectExecutionIdentityRun({ runId: "ordered-run" }, { ...database, now: admittedAt }),
    ).toMatchObject({
      identity: {
        state: "present",
        context: {
          contextId: "ordered-context",
          agentDefinition: { definitionRef: "main" },
          ingress: { kind: "system", boundary: "gateway.boot", state: "present" },
        },
      },
    });
    const persisted = openOpenClawStateDatabase(database)
      .db.prepare("SELECT context_json FROM execution_identity_contexts WHERE run_id = ?")
      .get("ordered-run") as { context_json: string };
    for (const raw of ["raw-conflict-source", "raw-conflict-principal"]) {
      expect(persisted.context_json).not.toContain(raw);
      expect(JSON.stringify(errors)).not.toContain(raw);
    }
  });

  it("keeps schema and insert failures off the admission path", async () => {
    const envelope = captureExecutionIdentityAdmissionEnvelope(
      {
        runId: "nonblocking-failure-run",
        agentId: "main",
        ingress: { kind: "local-cli", boundary: "agent-command.local" },
        runtime: { kind: "embedded" },
      },
      { runtimeInstanceId: "runtime-1" },
    );

    const schemaStateDir = tempDirs.make("openclaw-audit-writer-");
    const schemaDatabase = { env: { OPENCLAW_STATE_DIR: schemaStateDir } };
    openOpenClawStateDatabase(schemaDatabase).db.exec(`
      CREATE VIEW execution_identity_contexts AS
      SELECT 'context' AS context_id, 'run' AS run_id, 0 AS created_at,
             'unattributed' AS coverage_state, 2 AS context_bytes, '{}' AS context_json;
    `);
    closeOpenClawStateDatabaseForTest();
    const schemaErrors: string[] = [];
    const schemaWriter = createAuditEventWriter({
      stateDir: schemaStateDir,
      onError: (error) => schemaErrors.push(error),
    });
    const schemaStartedAt = performance.now();
    expect(schemaWriter.recordExecutionIdentity(captureWork(envelope))).toBe(true);
    expect(performance.now() - schemaStartedAt).toBeLessThan(250);
    await schemaWriter.ready;
    await schemaWriter.stop();
    expect(schemaErrors).toContain("audit execution identity persistence failed");

    const insertStateDir = tempDirs.make("openclaw-audit-writer-");
    const insertDatabase = { env: { OPENCLAW_STATE_DIR: insertStateDir } };
    persistExecutionIdentityAdmissionEnvelope(
      captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "insert-failure-setup",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local" },
          runtime: { kind: "embedded" },
        },
        { runtimeInstanceId: "runtime-setup" },
      ),
      insertDatabase,
    );
    const insertDb = openOpenClawStateDatabase(insertDatabase).db;
    insertDb.exec(`
      CREATE TRIGGER reject_identity_insert
      BEFORE INSERT ON execution_identity_contexts
      BEGIN
        SELECT RAISE(ABORT, 'raw-trigger-secret');
      END;
    `);
    const insertErrors: string[] = [];
    const insertWriter = createAuditEventWriter({
      stateDir: insertStateDir,
      onError: (error) => insertErrors.push(error),
    });
    const insertStartedAt = performance.now();
    expect(insertWriter.recordExecutionIdentity(captureWork(envelope))).toBe(true);
    expect(performance.now() - insertStartedAt).toBeLessThan(250);
    await insertWriter.ready;
    await insertWriter.stop();
    expect(insertErrors).toContain("audit execution identity persistence failed");
    expect(JSON.stringify(insertErrors)).not.toContain("raw-trigger-secret");
    insertDb.exec("DROP TRIGGER reject_identity_insert;");
    expect(
      inspectExecutionIdentityRun({ runId: envelope.runId }, insertDatabase).identity,
    ).toMatchObject({ state: "unknown", reasonCode: "run_not_found" });
  });

  it("keeps malformed, serialization, and key failures nonblocking and redaction-safe", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const rawSecret = "raw-worker-message-secret";
    persistExecutionIdentityAdmissionEnvelope(
      captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "before-key-loss",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local" },
          runtime: { kind: "embedded" },
        },
        { runtimeInstanceId: "runtime-1" },
      ),
      database,
    );
    openOpenClawStateDatabase(database).db.exec("DELETE FROM audit_identity_keys;");
    closeOpenClawStateDatabaseForTest();
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      stateDir,
      onError: (error) => errors.push(error),
    });
    const unserializable = {
      ...captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "serialization-run",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local" },
          runtime: { kind: "embedded" },
        },
        { runtimeInstanceId: "runtime-1" },
      ),
      ingress: {
        kind: "local-cli",
        boundary: "agent-command.local",
        state: "present",
        rawSourceRef: () => rawSecret,
      },
    };
    expect(writer.recordExecutionIdentity(captureWork(unserializable as never))).toBe(false);
    expect(writer.recordExecutionIdentity({ rawSecret } as never)).toBe(true);
    const invalidUnknown = {
      ...captureExecutionIdentityAdmissionEnvelope(
        {
          runId: "invalid-unknown-run",
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local" },
          runtime: { kind: "embedded" },
        },
        { runtimeInstanceId: "runtime-1" },
      ),
      invoker: { state: "unknown", rawPrincipalRef: rawSecret },
    };
    expect(writer.recordExecutionIdentity(captureWork(invalidUnknown as never))).toBe(true);
    expect(
      writer.recordExecutionIdentity(
        captureWork(
          captureExecutionIdentityAdmissionEnvelope(
            {
              runId: "after-key-loss",
              agentId: "main",
              ingress: { kind: "local-cli", boundary: "agent-command.local" },
              runtime: { kind: "embedded" },
            },
            { runtimeInstanceId: rawSecret },
          ),
        ),
      ),
    ).toBe(true);
    await writer.ready;
    await writer.stop();
    expect(errors).toContain("audit execution identity envelope could not be queued");
    expect(errors).toContain("audit execution identity envelope rejected");
    expect(errors).toContain("audit execution identity key unavailable");
    expect(JSON.stringify(errors)).not.toContain(rawSecret);
    expect(
      inspectExecutionIdentityRun({ runId: "after-key-loss" }, database).identity,
    ).toMatchObject({ state: "unknown", reasonCode: "run_not_found" });
  });
});
