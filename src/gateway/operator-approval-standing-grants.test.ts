// Cron standing grants: mint-at-resolution, fail-closed consumption, restart survival.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import {
  buildCronExecOperationBinding,
  consumeCronStandingGrant,
  listCronStandingGrants,
  parseCronExecOperationBinding,
  revokeCronStandingGrant,
} from "./operator-approval-standing-grants.js";
import {
  closeOrphanedOperatorApprovals,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "./operator-approval-store.js";

type StandingGrantDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approval_standing_grants" | "operator_approvals" | "cron_jobs"
>;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

const CRON_STORE_KEY = "/tmp/openclaw-standing-grant-test-store";
const NOW_MS = 1_756_000_000_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60_000;

const tempDirs: string[] = [];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-standing-grant-")),
  );
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function approval(id: string, overrides: Partial<NewOperatorApproval> = {}): NewOperatorApproval {
  return {
    id,
    kind: "exec",
    presentation: {
      kind: "exec",
      commandText: "echo standing",
      commandPreview: "echo standing",
      warningText: null,
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: { deviceId: "device-1", clientId: "client-1", deviceTokenAuth: true },
    reviewerDeviceIds: [],
    source: {
      agentId: "main",
      sessionKey: "agent:main:cron:job-1",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: null,
      toolName: "exec",
    },
    audienceSessionKeys: [],
    runtimeEpoch: "epoch-1",
    createdAtMs: NOW_MS,
    expiresAtMs: NOW_MS + 60_000,
    ...overrides,
  };
}

function cronJob(overrides: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id: "job-1",
    agentId: "main",
    name: "Standing grant job",
    enabled: true,
    createdAtMs: NOW_MS - 1_000,
    updatedAtMs: NOW_MS - 1_000,
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run the backup" },
    ...overrides,
  } as CronStoredJob;
}

/** Persists the job and returns the revision the loader observes for it. */
function seedCronJob(
  databaseOptions: OpenClawStateDatabaseOptions,
  job: CronStoredJob = cronJob(),
): string {
  const database = openOpenClawStateDatabase(databaseOptions);
  upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
  const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
  const loadedJob = loaded.store.jobs.find((entry) => entry.id === job.id);
  if (!loadedJob) {
    throw new Error(`seeded cron job ${job.id} did not load back`);
  }
  return resolveCronJobConfigRevision(loadedJob);
}

const OPERATION_BINDING = buildCronExecOperationBinding({
  command: "echo standing",
  cwd: "/work",
  env: undefined,
});

function mintGrant(params: {
  databaseOptions: OpenClawStateDatabaseOptions;
  approvalId?: string;
  jobConfigRevision: string;
  operationBinding?: string;
  nowMs?: number;
  expiresAtMs?: number | null;
}): void {
  const approvalId = params.approvalId ?? "approval-1";
  insertOperatorApproval({
    approval: approval(approvalId),
    databaseOptions: params.databaseOptions,
  });
  const resolved = resolveOperatorApproval({
    id: approvalId,
    decision: "allow-always",
    resolver: { kind: "device", id: "reviewer-1" },
    nowMs: params.nowMs ?? NOW_MS + 1_000,
    databaseOptions: params.databaseOptions,
    standingGrant: {
      agentId: "main",
      cronJobId: "job-1",
      jobConfigRevision: params.jobConfigRevision,
      operationBinding: params.operationBinding ?? OPERATION_BINDING,
      expiresAtMs: params.expiresAtMs !== undefined ? params.expiresAtMs : null,
    },
  });
  expect(resolved.outcome).toBe("resolved");
}

function readGrantRows(databaseOptions: OpenClawStateDatabaseOptions) {
  const database = openOpenClawStateDatabase(databaseOptions);
  if (!tableExists(database.db, "operator_approval_standing_grants")) {
    return null;
  }
  const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    stateDb.selectFrom("operator_approval_standing_grants").selectAll(),
  ).rows;
}

describe("cron standing grant mint", () => {
  it("mints a scoped grant in the allow-always resolution transaction", () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    mintGrant({ databaseOptions, jobConfigRevision: revision });
    const rows = readGrantRows(databaseOptions);
    expect(rows).toHaveLength(1);
    const grant = rows![0]!;
    expect(grant.minted_by_approval_id).toBe("approval-1");
    expect(grant.agent_id).toBe("main");
    expect(grant.cron_job_id).toBe("job-1");
    expect(grant.job_config_revision).toBe(revision);
    expect(grant.operation_binding).toBe(OPERATION_BINDING);
    expect(grant.created_at_ms).toBe(NOW_MS + 1_000);
    expect(grant.expires_at_ms).toBeNull();
    expect(grant.revoked_at_ms).toBeNull();
    expect(grant.use_count).toBe(0);
  });

  it("stamps frozen terms when the mint carries an expiry", () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    mintGrant({
      databaseOptions,
      jobConfigRevision: revision,
      expiresAtMs: NOW_MS + 1_000 + THIRTY_DAYS_MS,
    });
    const rows = readGrantRows(databaseOptions);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.expires_at_ms).toBe(NOW_MS + 1_000 + THIRTY_DAYS_MS);
  });

  it("does not create the table or mint for non-allow-always decisions", () => {
    const databaseOptions = createDatabaseOptions();
    insertOperatorApproval({ approval: approval("approval-1"), databaseOptions });
    const resolved = resolveOperatorApproval({
      id: "approval-1",
      decision: "allow-once",
      resolver: { kind: "device", id: "reviewer-1" },
      nowMs: NOW_MS + 1_000,
      databaseOptions,
      standingGrant: {
        agentId: "main",
        cronJobId: "job-1",
        jobConfigRevision: "sha256:rev",
        operationBinding: OPERATION_BINDING,
        expiresAtMs: null,
      },
    });
    expect(resolved.outcome).toBe("resolved");
    expect(readGrantRows(databaseOptions)).toBeNull();
  });

  it("replaces the prior grant for the same agent, job, and binding", () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    mintGrant({ databaseOptions, jobConfigRevision: revision });
    mintGrant({
      databaseOptions,
      approvalId: "approval-2",
      jobConfigRevision: revision,
      nowMs: NOW_MS + 5_000,
    });
    const rows = readGrantRows(databaseOptions);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.minted_by_approval_id).toBe("approval-2");
  });

  it("mints through the manager only when the mint resolver returns a spec", () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    const request = {
      command: "echo standing",
      host: "gateway",
      agentId: "main",
      runId: "run-1",
      cronExecutionSource: { jobId: "job-1", jobConfigRevision: revision },
      cronOperationBinding: OPERATION_BINDING,
    };
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "epoch-1", databaseOptions },
      resolveAllowedDecisions: () => ["allow-once", "allow-always", "deny"],
      resolveStandingGrantMint: (payload) => {
        const source = payload.cronExecutionSource;
        if (!source || !payload.cronOperationBinding || !payload.agentId) {
          return null;
        }
        return {
          agentId: payload.agentId,
          cronJobId: source.jobId,
          jobConfigRevision: source.jobConfigRevision,
          operationBinding: payload.cronOperationBinding,
        };
      },
    });
    const record = manager.create(request, 60_000, "approval-mgr");
    void manager.register(record, 60_000);
    const resolved = manager.resolveDetailed("approval-mgr", "allow-always", {
      kind: "device",
      id: "reviewer-1",
    });
    expect(resolved.outcome).toBe("resolved");
    const rows = readGrantRows(databaseOptions);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.minted_by_approval_id).toBe("approval-mgr");

    // A non-cron request never mints: the resolver returns null.
    const plainRecord = manager.create({ ...request, cronExecutionSource: null }, 60_000, "plain");
    void manager.register(plainRecord, 60_000);
    expect(
      manager.resolveDetailed("plain", "allow-always", { kind: "device", id: "reviewer-1" })
        .outcome,
    ).toBe("resolved");
    expect(readGrantRows(databaseOptions)).toHaveLength(1);
  });

  it("freezes terms at resolve: config default applies, per-resolve override wins", () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    const request = {
      command: "echo standing",
      host: "gateway",
      agentId: "main",
      runId: "run-1",
      cronExecutionSource: { jobId: "job-1", jobConfigRevision: revision },
      cronOperationBinding: OPERATION_BINDING,
    };
    // Resolve stamps created_at from the real clock; keep expiry ahead of it.
    const configuredExpiresAtMs = Date.now() + 10 * 24 * 60 * 60_000;
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "epoch-1", databaseOptions },
      resolveAllowedDecisions: () => ["allow-once", "allow-always", "deny"],
      resolveStandingGrantMint: (payload) => {
        const source = payload.cronExecutionSource;
        if (!source || !payload.cronOperationBinding || !payload.agentId) {
          return null;
        }
        return {
          agentId: payload.agentId,
          cronJobId: source.jobId,
          jobConfigRevision: source.jobConfigRevision,
          operationBinding: payload.cronOperationBinding,
        };
      },
      resolveStandingGrantExpiresAtMs: () => configuredExpiresAtMs,
    });
    const record = manager.create(request, 60_000, "approval-default");
    void manager.register(record, 60_000);
    expect(
      manager.resolveDetailed("approval-default", "allow-always", {
        kind: "device",
        id: "reviewer-1",
      }).outcome,
    ).toBe("resolved");
    expect(readGrantRows(databaseOptions)![0]!.expires_at_ms).toBe(configuredExpiresAtMs);

    const overrideExpiresAtMs = Date.now() + 99 * 24 * 60 * 60_000;
    const overrideBinding = buildCronExecOperationBinding({
      command: "echo standing-override",
      cwd: "/work",
      env: undefined,
    });
    const overrideRecord = manager.create(
      { ...request, cronOperationBinding: overrideBinding },
      60_000,
      "approval-override",
    );
    void manager.register(overrideRecord, 60_000);
    expect(
      manager.resolveDetailed(
        "approval-override",
        "allow-always",
        { kind: "device", id: "reviewer-1" },
        null,
        "operator",
        { grantExpiresAtMs: overrideExpiresAtMs },
      ).outcome,
    ).toBe("resolved");
    const overrideRow = readGrantRows(databaseOptions)!.find(
      (row) => row.minted_by_approval_id === "approval-override",
    );
    expect(overrideRow?.expires_at_ms).toBe(overrideExpiresAtMs);
  });
});

describe("cron standing grant consumption", () => {
  function seedMintedGrant(opts: { expiresAtMs?: number | null } = {}) {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    mintGrant({ databaseOptions, jobConfigRevision: revision, ...opts });
    return { databaseOptions, revision };
  }

  function consume(params: {
    databaseOptions: OpenClawStateDatabaseOptions;
    revision: string;
    operationBinding?: string;
    nowMs?: number;
  }) {
    return consumeCronStandingGrant({
      agentId: "main",
      cronJobId: "job-1",
      jobConfigRevision: params.revision,
      operationBinding: params.operationBinding ?? OPERATION_BINDING,
      nowMs: params.nowMs ?? NOW_MS + 10_000,
      databaseOptions: params.databaseOptions,
    });
  }

  it("consumes a valid grant and records usage facts", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    const first = consume({ databaseOptions, revision });
    expect(first.outcome).toBe("consumed");
    if (first.outcome !== "consumed") {
      throw new Error("expected consumed");
    }
    expect(first.grant.useCount).toBe(1);
    expect(first.grant.lastUsedAtMs).toBe(NOW_MS + 10_000);
    expect(first.grant.mintedByApprovalId).toBe("approval-1");
    const second = consume({ databaseOptions, revision, nowMs: NOW_MS + 20_000 });
    expect(second.outcome).toBe("consumed");
    if (second.outcome !== "consumed") {
      throw new Error("expected consumed");
    }
    expect(second.grant.useCount).toBe(2);
  });

  it("returns no-grant when the feature table was never created", () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    expect(consume({ databaseOptions, revision }).outcome).toBe("no-grant");
    // Reads never create the lazy table; older readers stay valid without it.
    expect(readGrantRows(databaseOptions)).toBeNull();
  });

  it("fails closed for a different operation binding", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    const otherBinding = buildCronExecOperationBinding({
      command: "echo different",
      cwd: "/work",
      env: undefined,
    });
    expect(consume({ databaseOptions, revision, operationBinding: otherBinding }).outcome).toBe(
      "no-grant",
    );
  });

  it("fails closed after a stamped expiry passes", () => {
    const { databaseOptions, revision } = seedMintedGrant({
      expiresAtMs: NOW_MS + 1_000 + THIRTY_DAYS_MS,
    });
    expect(
      consume({ databaseOptions, revision, nowMs: NOW_MS + 1_000 + THIRTY_DAYS_MS + 1 }).outcome,
    ).toBe("expired");
  });

  it("keeps until-revoked grants valid far past any calendar horizon", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    expect(
      consume({ databaseOptions, revision, nowMs: NOW_MS + 1_000 + 400 * THIRTY_DAYS_MS }).outcome,
    ).toBe("consumed");
  });

  it("fails closed after revocation", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approval_standing_grants")
        .set({ revoked_at_ms: NOW_MS + 2_000, revoked_by: "operator" }),
    );
    expect(consume({ databaseOptions, revision }).outcome).toBe("revoked");
  });

  it("fails closed when the cron job was deleted", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
    executeSqliteQuerySync(database.db, stateDb.deleteFrom("cron_jobs"));
    expect(consume({ databaseOptions, revision }).outcome).toBe("job-missing");
  });

  it("fails closed when the job config revision changed", () => {
    const { databaseOptions } = seedMintedGrant();
    const changedRevision = seedCronJob(
      databaseOptions,
      cronJob({ payload: { kind: "agentTurn", message: "run something else" } }),
    );
    // Next occurrence threads the new revision; the stored grant is stale.
    expect(consume({ databaseOptions, revision: changedRevision }).outcome).toBe(
      "job-revision-changed",
    );
  });

  it("fails closed when the authoritative job row disagrees with a stale thread", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    seedCronJob(databaseOptions, cronJob({ payload: { kind: "agentTurn", message: "changed" } }));
    // A raced run that still threads the minted revision must also fail closed.
    expect(consume({ databaseOptions, revision }).outcome).toBe("job-revision-changed");
  });

  it("fails closed when the minting approval row is gone or reversed", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    const database = openOpenClawStateDatabase(databaseOptions);
    const stateDb = getNodeSqliteKysely<StandingGrantDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb.deleteFrom("operator_approvals").where("approval_id", "=", "approval-1"),
    );
    // FK cascade may remove the grant with its parent; either path must
    // fall through to prompting, never consume.
    const outcome = consume({ databaseOptions, revision }).outcome;
    expect(["approval-missing", "no-grant"]).toContain(outcome);
  });

  it("survives a gateway restart and orphan cleanup of pending approvals", () => {
    const { databaseOptions, revision } = seedMintedGrant();
    closeOpenClawStateDatabaseForTest();
    // New runtime epoch: startup cancels orphaned pending approvals only; the
    // resolved allow-always parent and its grant remain valid durable truth.
    closeOrphanedOperatorApprovals({
      runtimeEpoch: "epoch-2",
      nowMs: NOW_MS + 5_000,
      databaseOptions,
    });
    expect(consume({ databaseOptions, revision }).outcome).toBe("consumed");
  });
});

describe("standing grant operator surfaces", () => {
  function seedListedGrant(opts: { expiresAtMs?: number | null } = {}) {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    mintGrant({ databaseOptions, jobConfigRevision: revision, ...opts });
    return { databaseOptions, revision };
  }

  it("lists grants with the owning job name and parseable operation", () => {
    const { databaseOptions } = seedListedGrant();
    const grants = listCronStandingGrants({ databaseOptions });
    expect(grants).toHaveLength(1);
    const grant = grants[0]!;
    expect(grant.cronJobId).toBe("job-1");
    expect(grant.cronJobName).toBe("Standing grant job");
    expect(grant.expiresAtMs).toBeNull();
    expect(grant.revokedAtMs).toBeNull();
    expect(grant.useCount).toBe(0);
    const operation = parseCronExecOperationBinding(grant.operationBinding);
    expect(operation?.command).toBe("echo standing");
  });

  it("returns an empty list before any grant created the table", () => {
    const databaseOptions = createDatabaseOptions();
    seedCronJob(databaseOptions);
    expect(listCronStandingGrants({ databaseOptions })).toEqual([]);
  });

  it("revokes once, reports already-revoked after, and fails closed at consume", () => {
    const { databaseOptions, revision } = seedListedGrant();
    const grantId = listCronStandingGrants({ databaseOptions })[0]!.grantId;
    const revoked = revokeCronStandingGrant({
      grantId,
      revokedBy: "operator-cli",
      nowMs: NOW_MS + 2_000,
      databaseOptions,
    });
    expect(revoked.outcome).toBe("revoked");
    expect(
      consumeCronStandingGrant({
        agentId: "main",
        cronJobId: "job-1",
        jobConfigRevision: revision,
        operationBinding: OPERATION_BINDING,
        nowMs: NOW_MS + 3_000,
        databaseOptions,
      }).outcome,
    ).toBe("revoked");
    expect(
      revokeCronStandingGrant({ grantId, revokedBy: "someone-else", databaseOptions }).outcome,
    ).toBe("already-revoked");
    const listed = listCronStandingGrants({ databaseOptions })[0]!;
    expect(listed.revokedAtMs).toBe(NOW_MS + 2_000);
    expect(listed.revokedBy).toBe("operator-cli");
  });

  it("reports not-found for unknown grants and before the table exists", () => {
    const databaseOptions = createDatabaseOptions();
    expect(
      revokeCronStandingGrant({ grantId: "missing", revokedBy: "x", databaseOptions }).outcome,
    ).toBe("not-found");
    seedListedGrant();
    expect(
      revokeCronStandingGrant({ grantId: "missing", revokedBy: "x", databaseOptions }).outcome,
    ).toBe("not-found");
  });

  it("rebuilds the unshipped mandatory-expiry table shape on first use", () => {
    const databaseOptions = createDatabaseOptions();
    const revision = seedCronJob(databaseOptions);
    const database = openOpenClawStateDatabase(databaseOptions);
    database.db.exec(`
      CREATE TABLE operator_approval_standing_grants (
        grant_id TEXT NOT NULL PRIMARY KEY CHECK (length(grant_id) > 0),
        minted_by_approval_id TEXT NOT NULL
          REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
        cron_job_id TEXT NOT NULL CHECK (length(cron_job_id) > 0),
        job_config_revision TEXT NOT NULL CHECK (length(job_config_revision) > 0),
        operation_binding TEXT NOT NULL CHECK (length(operation_binding) > 0),
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= created_at_ms),
        revoked_at_ms INTEGER,
        revoked_by TEXT,
        last_used_at_ms INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    mintGrant({ databaseOptions, jobConfigRevision: revision });
    const grants = listCronStandingGrants({ databaseOptions });
    expect(grants).toHaveLength(1);
    expect(grants[0]!.expiresAtMs).toBeNull();
  });
});
