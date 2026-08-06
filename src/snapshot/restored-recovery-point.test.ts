import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  captureFinalRecoveryPoint,
  FINAL_RECOVERY_POINT_REQUEST_VERSION,
} from "./final-recovery-point.js";
import { createLocalSqliteSnapshotProvider } from "./local-repository.js";
import {
  readRecoveryJournalRecord,
  resolveRecoveryJournalPath,
  writeRecoveryJournalRecord,
} from "./recovery-journal.js";
import {
  createRecoveryPointAcceptance,
  createRecoveryPointManifest,
  type RecoveryPointSqliteSnapshot,
} from "./recovery-point.js";
import {
  loadRestoredAdmissionDescriptor,
  parseRestoredRecoveryPointRequest,
  RESTORED_RECOVERY_POINT_REQUEST_VERSION,
  restoreAcceptedRecoveryPoint,
  type RestoredRecoveryPointRequest,
} from "./restored-recovery-point.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

describe("restored recovery-point admission", () => {
  it("restores accepted bytes to fresh canonical paths and replays the exact receipt", async () => {
    const fixture = await createFixture();

    const first = await restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv);
    const replay = await restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      runtimeLineage: "runtime/tenant-7",
      destinationRuntimeGeneration: "generation-8",
      restoreOperationId: "restore-8",
      recoveryPointId: fixture.request.recoveryPointId,
      acceptanceSetId: fixture.request.acceptanceSetId,
    });
    await expect(fs.access(resolveOpenClawStateSqlitePath(fixture.destinationEnv))).resolves.toBe(
      undefined,
    );
    await expect(
      fs.access(resolveOpenClawAgentSqlitePath({ agentId: "main", env: fixture.destinationEnv })),
    ).resolves.toBe(undefined);
    await expect(
      readRecoveryJournalRecord(first.startupDescriptorPath, "startup"),
    ).resolves.toEqual({
      version: "openclaw-restored-admission/v1",
      journalPath: first.startupDescriptorPath,
      result: first,
    });
  });

  it("re-registers restored agent databases for the destination runtime", async () => {
    const fixture = await createFixture({ relocatedAgent: true });
    await restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv);
    process.env.OPENCLAW_STATE_DIR = fixture.destinationEnv.OPENCLAW_STATE_DIR;

    const next = await captureFinalRecoveryPoint({
      version: FINAL_RECOVERY_POINT_REQUEST_VERSION,
      runtimeLineage: "runtime/tenant-7",
      handoffId: "handoff-8",
      sourceGeneration: "generation-8",
      capturedAt: "2026-07-22T19:00:00.000Z",
      repositoryPath: path.join(fixture.tempDir, "next-recovery-points"),
      ownerInventory: { ...sourceOwnerInventory(), sourceRuntimeGeneration: "generation-8" },
      closure: {
        gateway: "cleanly-stopped",
        authoritativeWriters: "stopped",
        evidenceId: "supervisor-stop-8",
      },
    });

    expect(next.components.map((component) => component.componentId)).toEqual([
      "sqlite/global",
      "sqlite/agent/main",
    ]);
    await expect(
      fs.access(resolveOpenClawAgentSqlitePath({ agentId: "main", env: fixture.destinationEnv })),
    ).resolves.toBe(undefined);
  });

  it("quarantines changed accepted bytes before mutating destination state", async () => {
    const fixture = await createFixture();
    await fs.appendFile(
      path.join(fixture.final.components[0]!.snapshotPath, "database.sqlite"),
      "changed",
    );

    await expect(
      restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv),
    ).rejects.toMatchObject({
      code: "restored-admission.verification-failed",
      disposition: "quarantine",
    });
    await expect(
      fs.access(resolveOpenClawStateSqlitePath(fixture.destinationEnv)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds required owner obligations before durable intent or target mutation", async () => {
    const fixture = await createFixture();
    const snapshots = await resolveFixtureSnapshots(fixture.final.recoveryPointPath);
    const manifest = await createRecoveryPointManifest({
      snapshots,
      ownerInventory: sourceOwnerInventory(),
      obligations: {
        external: [
          {
            id: "secret/provider-api-key",
            kind: "secret-ref",
            owner: "secrets",
            readinessRequired: true,
          },
        ],
      },
      now: () => new Date("2026-07-22T18:00:00.000Z"),
    });
    const acceptance = createRecoveryPointAcceptance(manifest);
    await fs.writeFile(
      path.join(fixture.final.recoveryPointPath, "manifest.json"),
      `${stableStringify(manifest)}\n`,
    );

    await expect(
      restoreAcceptedRecoveryPoint(
        {
          ...fixture.request,
          recoveryPointId: manifest.recoveryPointId,
          acceptanceSetId: acceptance.acceptanceSetId,
        },
        fixture.destinationEnv,
      ),
    ).rejects.toMatchObject({
      code: "restored-admission.dependency-hold",
      disposition: "hold",
    });
    await expect(
      fs.access(resolveOpenClawStateSqlitePath(fixture.destinationEnv)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("quarantines durable intent without a committed result", async () => {
    const fixture = await createFixture();
    const journalPath = await prepareJournal(fixture.request);
    await writeRecoveryJournalRecord(journalPath, "intent", fixture.request);

    await expect(
      restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv),
    ).rejects.toMatchObject({
      code: "restored-admission.operation-conflict",
      disposition: "quarantine",
    });
    await expect(
      fs.access(resolveOpenClawStateSqlitePath(fixture.destinationEnv)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["intent", "result"])(
    "quarantines malformed durable %s instead of throwing raw JSON errors",
    async (recordName) => {
      const fixture = await createFixture();
      const journalPath = await prepareJournal(fixture.request);
      await writeRecoveryJournalRecord(journalPath, recordName, {});
      replaceJournalPayload(journalPath, recordName, "{");

      await expect(
        restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv),
      ).rejects.toMatchObject({
        code: "restored-admission.operation-conflict",
        disposition: "quarantine",
      });
    },
  );

  it("quarantines a malformed startup descriptor as typed journal corruption", async () => {
    const fixture = await createFixture();
    const result = await restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv);
    replaceJournalPayload(result.startupDescriptorPath, "startup", "{");

    await expect(
      loadRestoredAdmissionDescriptor(result.startupDescriptorPath),
    ).rejects.toMatchObject({
      code: "restored-admission.operation-conflict",
      disposition: "quarantine",
    });
  });

  it("quarantines startup descriptors that diverge from committed restore records", async () => {
    const fixture = await createFixture();
    const result = await restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv);
    const startup = await readRecoveryJournalRecord(result.startupDescriptorPath, "startup");
    replaceJournalPayload(
      result.startupDescriptorPath,
      "startup",
      stableStringify({
        ...(startup as object),
        result: {
          ...result,
          restoreOperationId: "restore-other",
        },
      }),
    );

    await expect(
      loadRestoredAdmissionDescriptor(result.startupDescriptorPath),
    ).rejects.toMatchObject({
      code: "restored-admission.operation-conflict",
      disposition: "quarantine",
    });
  });

  it("quarantines committed result metadata that conflicts with durable intent", async () => {
    const fixture = await createFixture();
    const result = await restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv);
    const { restoreReceiptIdentity: _restoreReceiptIdentity, ...resultWithoutReceipt } = result;
    const conflictingWithoutReceipt = {
      ...resultWithoutReceipt,
      runtimeLineage: "runtime/other-tenant",
    };
    replaceJournalPayload(
      result.startupDescriptorPath,
      "result",
      stableStringify({
        ...conflictingWithoutReceipt,
        restoreReceiptIdentity: sha256Hex(stableStringify(conflictingWithoutReceipt)),
      }),
    );

    await expect(
      restoreAcceptedRecoveryPoint(fixture.request, fixture.destinationEnv),
    ).rejects.toMatchObject({
      code: "restored-admission.operation-conflict",
      disposition: "quarantine",
    });
  });

  it("rejects a recovery point that differs from the accepted owner receipt", async () => {
    const fixture = await createFixture();

    await expect(
      restoreAcceptedRecoveryPoint(
        {
          ...fixture.request,
          ownerInventory: { ...fixture.request.ownerInventory, revision: "different-revision" },
        },
        fixture.destinationEnv,
      ),
    ).rejects.toMatchObject({
      code: "restored-admission.verification-failed",
      disposition: "quarantine",
    });
    await expect(
      fs.access(resolveOpenClawStateSqlitePath(fixture.destinationEnv)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires normalized absolute paths and rejects legacy caller inventory", () => {
    const request = baseRestoreRequest({
      recoveryPointPath: path.resolve("recovery-point"),
      journalRoot: path.resolve("restore-journal"),
      recoveryPointId: "a".repeat(64),
      acceptanceSetId: "b".repeat(64),
      ownerInventory: sourceOwnerInventory(),
    });
    expect(() =>
      parseRestoredRecoveryPointRequest(JSON.stringify({ ...request, journalRoot: "relative" })),
    ).toThrow("normalized absolute path");
    expect(() =>
      parseRestoredRecoveryPointRequest(JSON.stringify({ ...request, expectedAgentIds: ["main"] })),
    ).toThrow("request is invalid");
    expect(() =>
      parseRestoredRecoveryPointRequest(
        JSON.stringify({
          ...request,
          ownerInventory: { ...request.ownerInventory, agentIds: ["../../outside"] },
        }),
      ),
    ).toThrow("owner inventory is invalid");
  });
});

async function prepareJournal(request: RestoredRecoveryPointRequest): Promise<string> {
  const journalDirectory = path.join(request.journalRoot, operationId(request));
  await fs.mkdir(journalDirectory, { recursive: true, mode: 0o700 });
  return resolveRecoveryJournalPath(journalDirectory);
}

function replaceJournalPayload(databasePath: string, recordType: string, payload: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    database
      .prepare("UPDATE recovery_journal_records SET payload_json = ? WHERE record_type = ?")
      .run(payload, recordType);
  } finally {
    database.close();
  }
}

async function createFixture(options: { relocatedAgent?: boolean } = {}) {
  const tempDir = tempDirs.make("openclaw-restored-recovery-point-");
  const sourceStateDir = path.join(tempDir, "source-state");
  process.env.OPENCLAW_STATE_DIR = sourceStateDir;
  const globalPath = resolveOpenClawStateSqlitePath();
  const agentPath = options.relocatedAgent
    ? path.join(tempDir, "relocated", "openclaw-main.sqlite")
    : resolveOpenClawAgentSqlitePath({ agentId: "main" });
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  createDatabase(globalPath, "global");
  createDatabase(agentPath, "agent", "main");
  registerOpenClawAgentDatabase({ agentId: "main", path: agentPath });
  const final = await captureFinalRecoveryPoint({
    version: FINAL_RECOVERY_POINT_REQUEST_VERSION,
    runtimeLineage: "runtime/tenant-7",
    handoffId: "handoff-7",
    sourceGeneration: "generation-7",
    capturedAt: "2026-07-22T18:00:00.000Z",
    repositoryPath: path.join(tempDir, "recovery-points"),
    ownerInventory: sourceOwnerInventory(),
    closure: {
      gateway: "cleanly-stopped",
      authoritativeWriters: "stopped",
      evidenceId: "supervisor-stop-7",
    },
  });
  const destinationEnv = { OPENCLAW_STATE_DIR: path.join(tempDir, "destination-state") };
  const request = baseRestoreRequest({
    recoveryPointPath: final.recoveryPointPath,
    journalRoot: path.join(tempDir, "restore-journal"),
    recoveryPointId: final.recoveryPointId,
    acceptanceSetId: final.acceptanceSetId,
    ownerInventory: sourceOwnerInventory(),
  });
  return { destinationEnv, final, request, tempDir };
}

function baseRestoreRequest(
  values: Pick<
    RestoredRecoveryPointRequest,
    "recoveryPointPath" | "journalRoot" | "recoveryPointId" | "acceptanceSetId" | "ownerInventory"
  >,
): RestoredRecoveryPointRequest {
  return {
    version: RESTORED_RECOVERY_POINT_REQUEST_VERSION,
    runtimeLineage: "runtime/tenant-7",
    lifecycleOwnerGeneration: "owner-generation-8",
    destinationRuntimeGeneration: "generation-8",
    restoreOperationId: "restore-8",
    destinationOwner: "lobster/tenant-7",
    admissionIdentity: "admission-8",
    ...values,
  };
}

function sourceOwnerInventory() {
  return {
    version: "openclaw-runtime-sqlite-inventory/v1" as const,
    owner: "openclaw-state" as const,
    sourceRuntimeGeneration: "generation-7",
    revision: "selected-agents-7",
    agentIds: ["main"],
  };
}

function createDatabase(databasePath: string, role: "global" | "agent", agentId?: string): void {
  const sqlite = requireNodeSqlite();
  const database = new sqlite.DatabaseSync(databasePath);
  const schema = role === "global" ? OPENCLAW_STATE_SCHEMA_SQL : OPENCLAW_AGENT_SCHEMA_SQL;
  const version = role === "global" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
  try {
    database.exec(`${schema}\nPRAGMA user_version = ${version};`);
    database
      .prepare(
        `INSERT INTO schema_meta (
          meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
        ) VALUES ('primary', ?, ?, ?, NULL, 1, 1)`,
      )
      .run(role, version, role === "agent" ? agentId! : null);
  } finally {
    database.close();
  }
}

async function resolveFixtureSnapshots(
  recoveryPointPath: string,
): Promise<RecoveryPointSqliteSnapshot[]> {
  const repositories = [
    { path: path.join(recoveryPointPath, "components", "global"), role: "global" as const },
    {
      path: path.join(recoveryPointPath, "components", "agents", "main"),
      role: "agent" as const,
    },
  ];
  return await Promise.all(
    repositories.map(async (repository) => {
      const provider = createLocalSqliteSnapshotProvider({
        repositoryPath: repository.path,
        allowedDatabaseRoles: [repository.role],
      });
      const entries = await provider.list();
      return { provider, ref: entries[0]!.ref };
    }),
  );
}

function operationId(request: RestoredRecoveryPointRequest): string {
  return sha256Hex(
    stableStringify({
      runtimeLineage: request.runtimeLineage,
      destinationRuntimeGeneration: request.destinationRuntimeGeneration,
      restoreOperationId: request.restoreOperationId,
    }),
  );
}
