import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: undefined as
    | {
        agentId: string;
        db: DatabaseSync;
        path: string;
        walMaintenance: never;
      }
    | undefined,
  logWarn: vi.fn(),
}));

vi.mock("../state/openclaw-agent-db.js", () => ({
  openOpenClawAgentDatabase: () => {
    if (!mocks.database) {
      throw new Error("test database is unavailable");
    }
    return mocks.database;
  },
}));

vi.mock("../logger.js", () => ({
  logWarn: mocks.logWarn,
}));

const {
  hydrateMemoryRunExposureFromLedger,
  persistMemoryRunExposureBeforeContent,
  readDurableMemoryRunExposure,
} = await import("./memory-run-exposure-ledger.js");
const { clearMemoryRunExposureForTest, prepareMemoryRunExposure } =
  await import("./memory-run-exposure.js");

let database: DatabaseSync | undefined;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  mocks.database = {
    agentId: "main",
    db: database,
    path: ":memory:",
    walMaintenance: undefined as never,
  };
});

afterEach(() => {
  clearMemoryRunExposureForTest();
  mocks.database = undefined;
  database?.close();
  database = undefined;
});

function prepare(sessionId: string) {
  return prepareMemoryRunExposure({
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:direct:${sessionId}`,
    runId: "shared-run-id",
    contextFingerprint: `fingerprint:${sessionId}`,
    planId: `plan:${sessionId}`,
    memoryPolicyRevision: "policy-1",
    sourcePolicySetIds: ["source-policy-1"],
    exposedResourceRevisions: ["revision-1"],
    exposureReceiptIds: ["exposure-1"],
    egressReceiptIds: ["egress-1"],
    deliveryAudiences: [{ kind: "user", id: "alice" }],
    deliveryRevision: "delivery-1",
    egressRegistryRevision: "egress-1",
    sessionIdentityRevision: "identity-1",
    subjectRevision: "subject-1",
  });
}

describe("memory pre-output exposure ledger", () => {
  it("commits content-free rows before publication and separates the same raw run across sessions", () => {
    const first = prepare("session-a");
    const second = prepare("session-b");

    expect(persistMemoryRunExposureBeforeContent(first)).toBe(true);
    expect(persistMemoryRunExposureBeforeContent(second)).toBe(true);
    expect(first.durableRunScopeId).not.toBe(second.durableRunScopeId);

    expect(
      database
        ?.prepare(
          `SELECT session_id, run_id, revision_number, exposure_set_id,
                  source_policy_set_ids_json, exposed_resource_revisions_json
           FROM memory_preoutput_exposure_ledger
           ORDER BY session_id`,
        )
        .all(),
    ).toEqual([
      {
        session_id: "session-a",
        run_id: "shared-run-id",
        revision_number: 1,
        exposure_set_id: first.exposureSetId,
        source_policy_set_ids_json: '["source-policy-1"]',
        exposed_resource_revisions_json: '["revision-1"]',
      },
      {
        session_id: "session-b",
        run_id: "shared-run-id",
        revision_number: 1,
        exposure_set_id: second.exposureSetId,
        source_policy_set_ids_json: '["source-policy-1"]',
        exposed_resource_revisions_json: '["revision-1"]',
      },
    ]);
  });

  it("fails closed on a duplicate revision without adding a partial row", () => {
    const snapshot = prepare("session-a");

    expect(persistMemoryRunExposureBeforeContent(snapshot)).toBe(true);
    expect(persistMemoryRunExposureBeforeContent(snapshot)).toBe(false);
    expect(
      database?.prepare("SELECT count(*) AS count FROM memory_preoutput_exposure_ledger").get(),
    ).toEqual({ count: 1 });
  });

  it("emits a fixed diagnostic without a caught database error", () => {
    const snapshot = prepare("session-a");
    mocks.database = undefined;

    expect(persistMemoryRunExposureBeforeContent(snapshot)).toBe(false);

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "memory exposure ledger unavailable: persist-failed",
    );
    expect(JSON.stringify(mocks.logWarn.mock.calls)).not.toContain("test database is unavailable");
  });

  it("rehydrates a durable tail after restart before advancing the same run", () => {
    const first = prepare("session-a");
    expect(persistMemoryRunExposureBeforeContent(first)).toBe(true);

    clearMemoryRunExposureForTest();
    expect(
      hydrateMemoryRunExposureFromLedger({
        agentId: "main",
        sessionId: "session-a",
        runId: "shared-run-id",
      }),
    ).toBe(true);
    const second = prepare("session-a");
    expect(second.revisionNumber).toBe(2);
    expect(second.previous?.exposureSetId).toBe(first.exposureSetId);
    expect(persistMemoryRunExposureBeforeContent(second)).toBe(true);

    clearMemoryRunExposureForTest();
    const durable = readDurableMemoryRunExposure({
      database: mocks.database as never,
      sessionId: "session-a",
      runId: "shared-run-id",
    });
    expect(durable).toMatchObject({
      exposureSetId: second.exposureSetId,
      revisionNumber: 2,
      previous: { exposureSetId: first.exposureSetId, revisionNumber: 1 },
    });
  });

  it("clears an old state root's process tail before starting the same run in a fresh ledger", () => {
    const staleStateDatabase = database as DatabaseSync;
    const staleSnapshot = prepare("session-a");
    expect(persistMemoryRunExposureBeforeContent(staleSnapshot)).toBe(true);
    expect(
      hydrateMemoryRunExposureFromLedger({
        agentId: "main",
        sessionId: "session-a",
        runId: "shared-run-id",
      }),
    ).toBe(true);

    const freshStateDatabase = new DatabaseSync(":memory:");
    database = freshStateDatabase;
    mocks.database = {
      agentId: "main",
      db: freshStateDatabase,
      path: ":memory:",
      walMaintenance: undefined as never,
    };
    expect(
      hydrateMemoryRunExposureFromLedger({
        agentId: "main",
        sessionId: "session-a",
        runId: "shared-run-id",
      }),
    ).toBe(true);

    const freshSnapshot = prepare("session-a");
    expect(freshSnapshot.revisionNumber).toBe(1);
    expect(persistMemoryRunExposureBeforeContent(freshSnapshot)).toBe(true);
    expect(
      freshStateDatabase
        .prepare(
          `SELECT revision_number FROM memory_preoutput_exposure_ledger
           WHERE agent_id = 'main' AND session_id = 'session-a' AND run_id = 'shared-run-id'`,
        )
        .all(),
    ).toEqual([{ revision_number: 1 }]);

    staleStateDatabase.close();
  });

  it("fails closed when a different durable tail conflicts with the process tail", () => {
    const firstStateDatabase = database as DatabaseSync;
    const firstSnapshot = prepare("session-a");
    expect(persistMemoryRunExposureBeforeContent(firstSnapshot)).toBe(true);

    const secondStateDatabase = new DatabaseSync(":memory:");
    mocks.database = {
      agentId: "main",
      db: secondStateDatabase,
      path: ":memory:",
      walMaintenance: undefined as never,
    };
    const secondSnapshot = prepare("session-a");
    expect(secondSnapshot.revisionNumber).toBe(1);
    expect(persistMemoryRunExposureBeforeContent(secondSnapshot)).toBe(true);

    mocks.database = {
      agentId: "main",
      db: firstStateDatabase,
      path: ":memory:",
      walMaintenance: undefined as never,
    };
    expect(
      hydrateMemoryRunExposureFromLedger({
        agentId: "main",
        sessionId: "session-a",
        runId: "shared-run-id",
      }),
    ).toBe(true);

    mocks.database = {
      agentId: "main",
      db: secondStateDatabase,
      path: ":memory:",
      walMaintenance: undefined as never,
    };
    expect(
      hydrateMemoryRunExposureFromLedger({
        agentId: "main",
        sessionId: "session-a",
        runId: "shared-run-id",
      }),
    ).toBe(false);

    secondStateDatabase.close();
  });
});
