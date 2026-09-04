import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL } from "../../state/openclaw-state-schema-v12-foldin.test-support.js";
import {
  createSkillResourceAllocationLedger,
  type SkillResourceAllocationLocation,
  type SkillResourceAllocationRecord,
} from "./skill-resource-allocation-ledger.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const ledgerScope = "worker.skill-resource-allocation.v1";
const allocationId = "1".repeat(32);
const leaseToken = "2".repeat(64);
const incarnationId = "3".repeat(32);
const execFileAsync = promisify(execFile);
const location: SkillResourceAllocationLocation = {
  identity: "1:2",
  registryIdentity: "3:4",
  workspaceIdentity: "5:6",
};

afterEach(() => closeOpenClawStateDatabaseForTest());

function createFixture(params: { incarnation?: string; stateDir?: string } = {}) {
  const stateDir = params.stateDir ?? temps.make("skill-resource-allocation-ledger-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  return {
    databasePath: resolveOpenClawStateSqlitePath(env),
    ledger: createSkillResourceAllocationLedger({
      databaseOptions: { env },
      incarnationId: params.incarnation ?? incarnationId,
    }),
    stateDir,
  };
}

const intent = {
  allocationId,
  environmentId: "environment-1",
  ownerEpoch: 7,
  workspace: "/remote/workspace",
  leaseToken,
};

function rawRecord(overrides: Partial<SkillResourceAllocationRecord> = {}) {
  return {
    version: 1,
    revision: 1,
    allocationId,
    environmentId: "environment-1",
    ownerEpoch: 7,
    workspace: "/remote/workspace",
    leaseToken,
    incarnationId,
    phase: "intent",
    createdAtMs: 10,
    updatedAtMs: 10,
    location: null,
    ...overrides,
  };
}

type RawLeaseOverrides = {
  scope?: string;
  leaseKey?: string;
  owner?: string;
  expiresAt?: number | bigint | null;
  heartbeatAt?: number | bigint | null;
  payloadJson?: string | null;
  createdAt?: number | bigint;
  updatedAt?: number | bigint;
};

function writeRawLease(databasePath: string, overrides: RawLeaseOverrides = {}): void {
  closeOpenClawStateDatabaseForTest();
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `INSERT INTO state_leases (
           scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, lease_key) DO UPDATE SET
           owner = excluded.owner,
           expires_at = excluded.expires_at,
           heartbeat_at = excluded.heartbeat_at,
           payload_json = excluded.payload_json,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        overrides.scope ?? ledgerScope,
        overrides.leaseKey ?? allocationId,
        overrides.owner ?? incarnationId,
        overrides.expiresAt ?? null,
        overrides.heartbeatAt ?? null,
        overrides.payloadJson === undefined ? JSON.stringify(rawRecord()) : overrides.payloadJson,
        overrides.createdAt ?? 10,
        overrides.updatedAt ?? 10,
      );
  } finally {
    database.close();
  }
}

function readScopeRows(databasePath: string, scope = ledgerScope): Array<Record<string, unknown>> {
  closeOpenClawStateDatabaseForTest();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statement = database.prepare(
      `SELECT scope, lease_key, owner, expires_at, heartbeat_at, payload_json,
              created_at, updated_at
         FROM state_leases
        WHERE scope = ?
        ORDER BY lease_key`,
    );
    statement.setReadBigInts(true);
    return statement.all(scope) as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

function quarantineRows(databasePath: string): Array<Record<string, unknown>> {
  return readScopeRows(databasePath).filter(
    (row) => typeof row.lease_key === "string" && row.lease_key.startsWith("quarantine.v1."),
  );
}

describe("skill resource allocation ledger", () => {
  it("commits intent, allocation, and cleanup through revision-fenced transactions", async () => {
    const { databasePath, ledger } = createFixture();
    const created = await ledger.createIntent(intent);
    expect(created).toMatchObject({ phase: "intent", revision: 1, location: null });
    expect(readScopeRows(databasePath)).toMatchObject([
      {
        scope: ledgerScope,
        lease_key: allocationId,
        owner: incarnationId,
        expires_at: null,
        heartbeat_at: null,
      },
    ]);

    const allocated = await ledger.markAllocated(allocationId, created.revision, location);
    expect(allocated).toMatchObject({ phase: "allocated", revision: 2, location });

    const pending = await ledger.markCleanupPending(allocationId, allocated.revision);
    expect(pending).toMatchObject({ phase: "cleanup-pending", revision: 3, location });
    const complete = await ledger.markCleanupComplete(allocationId, pending.revision);
    expect(complete).toMatchObject({ phase: "cleanup-complete", revision: 4, location });
    await ledger.remove(allocationId, complete.revision);
    await expect(ledger.list()).resolves.toEqual([]);
  });

  it("persists a provisional locator before cleanup can mutate the receiver", async () => {
    const { ledger } = createFixture();
    const created = await ledger.createIntent(intent);

    const pending = await ledger.markCleanupPending(
      allocationId,
      created.revision,
      undefined,
      location,
    );

    expect(pending).toMatchObject({
      phase: "cleanup-pending",
      revision: 3,
      location,
    });
    await expect(ledger.markAllocated(allocationId, pending.revision, location)).rejects.toThrow(
      "not awaiting allocation",
    );
    const complete = await ledger.markCleanupComplete(allocationId, pending.revision);
    expect(complete).toMatchObject({ phase: "cleanup-complete", revision: 4, location });
    await ledger.remove(allocationId, complete.revision);
    await expect(ledger.list()).resolves.toEqual([]);
  });

  it("allows only one database owner to advance an observed revision", async () => {
    const stateDir = temps.make("skill-resource-allocation-ledger-cas-");
    const first = createFixture({ stateDir }).ledger;
    const second = createFixture({ incarnation: "4".repeat(32), stateDir }).ledger;
    const created = await first.createIntent(intent);
    const results = await Promise.allSettled([
      first.markCleanupPending(allocationId, created.revision),
      second.markCleanupPending(allocationId, created.revision),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(first.list()).resolves.toMatchObject([{ phase: "cleanup-pending", revision: 2 }]);
  });

  it("runs an authoritative fence inside the same transaction before every mutation", async () => {
    const { ledger } = createFixture();
    const rejectedFence = vi.fn(() => {
      throw new Error("ownership lease was replaced");
    });
    await expect(ledger.createIntent(intent, rejectedFence)).rejects.toThrow(
      "ownership lease was replaced",
    );
    expect(rejectedFence).toHaveBeenCalledOnce();
    await expect(ledger.list()).resolves.toEqual([]);

    const acceptedFence = vi.fn((database: DatabaseSync) => {
      expect(database.isTransaction).toBe(true);
    });
    const created = await ledger.createIntent(intent, acceptedFence);
    await ledger.markAllocated(allocationId, created.revision, location, acceptedFence);
    await ledger.markCleanupPending(allocationId, 2, acceptedFence);
    await ledger.markCleanupComplete(allocationId, 3, acceptedFence);
    await ledger.remove(allocationId, 4, acceptedFence);
    await expect(ledger.list(acceptedFence)).resolves.toEqual([]);
    expect(acceptedFence).toHaveBeenCalledTimes(6);
  });

  it("serializes compare-and-replace across independent host processes", async () => {
    const { databasePath, ledger } = createFixture();
    const created = await ledger.createIntent(intent);
    closeOpenClawStateDatabaseForTest();
    const moduleUrl = new URL("./skill-resource-allocation-ledger.ts", import.meta.url).href;
    const runWriter = (childIncarnation: string) =>
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `const { createSkillResourceAllocationLedger } = await import(${JSON.stringify(moduleUrl)});
           const ledger = createSkillResourceAllocationLedger({
             databaseOptions: { path: ${JSON.stringify(databasePath)} },
             incarnationId: ${JSON.stringify(childIncarnation)},
           });
           await ledger.markCleanupPending(${JSON.stringify(allocationId)}, ${created.revision});`,
        ],
        { timeout: 15_000 },
      );
    const results = await Promise.allSettled([
      runWriter("4".repeat(32)),
      runWriter("5".repeat(32)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(ledger.list()).resolves.toMatchObject([{ phase: "cleanup-pending", revision: 2 }]);
  });

  it("canonicalizes valid input instead of persisting caller-owned properties", async () => {
    const { ledger } = createFixture();
    await expect(ledger.createIntent(intent, [] as never)).rejects.toThrow(
      "Invalid skill resource allocation transaction fence",
    );
    const created = await ledger.createIntent({
      ...intent,
      revision: 9000,
      operatorNote: "not part of the ledger schema",
    } as never);

    expect(created).toMatchObject({ revision: 1, phase: "intent" });
    expect(created).not.toHaveProperty("operatorNote");
    await expect(ledger.list()).resolves.toEqual([created]);
  });

  it("keeps persisted timestamps monotonic when the host wall clock moves backward", async () => {
    const { ledger } = createFixture();
    const created = await ledger.createIntent(intent);
    const clock = vi.spyOn(Date, "now").mockReturnValue(created.updatedAtMs - 1);
    try {
      const allocated = await ledger.markAllocated(allocationId, created.revision, location);
      expect(allocated.updatedAtMs).toBe(created.updatedAtMs);
      const pending = await ledger.markCleanupPending(allocationId, allocated.revision);
      expect(pending.updatedAtMs).toBe(created.updatedAtMs);
    } finally {
      clock.mockRestore();
    }
  });

  it("snapshots every getter-backed constructor and transition field once", async () => {
    const stateDir = temps.make("skill-resource-allocation-ledger-getters-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const reads = new Map<string, number>();
    const once = (name: string, first: unknown, later: unknown) => () => {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count === 1 ? first : later;
    };
    const databaseOptions = Object.defineProperties(
      {},
      {
        database: { enumerable: true, get: once("database", undefined, []) },
        env: { enumerable: true, get: once("env", env, []) },
        path: { enumerable: true, get: once("path", undefined, 42) },
        readOnly: { enumerable: true, get: once("readOnly", undefined, "yes") },
      },
    );
    const ledger = createSkillResourceAllocationLedger(
      Object.defineProperties(
        {},
        {
          databaseOptions: {
            enumerable: true,
            get: once("databaseOptions", databaseOptions, []),
          },
          incarnationId: {
            enumerable: true,
            get: once("incarnationId", incarnationId, []),
          },
        },
      ) as never,
    );
    const getterIntent = Object.defineProperties(
      {},
      {
        allocationId: { enumerable: true, get: once("allocationId", allocationId, "invalid") },
        environmentId: { enumerable: true, get: once("environmentId", "environment-1", "") },
        ownerEpoch: { enumerable: true, get: once("ownerEpoch", 7, -1) },
        workspace: {
          enumerable: true,
          get: once("workspace", "/remote/workspace", "relative"),
        },
        leaseToken: { enumerable: true, get: once("leaseToken", leaseToken, "invalid") },
      },
    );
    const created = await ledger.createIntent(getterIntent as never);
    const getterLocation = Object.defineProperties(
      {},
      {
        identity: { enumerable: true, get: once("identity", "1:2", []) },
        registryIdentity: { enumerable: true, get: once("registryIdentity", "3:4", []) },
        workspaceIdentity: { enumerable: true, get: once("workspaceIdentity", "5:6", []) },
      },
    );
    await ledger.markAllocated(allocationId, created.revision, getterLocation as never);

    expect(Object.fromEntries(reads)).toEqual({
      databaseOptions: 1,
      incarnationId: 1,
      database: 1,
      env: 1,
      path: 1,
      readOnly: 1,
      allocationId: 1,
      environmentId: 1,
      ownerEpoch: 1,
      workspace: 1,
      leaseToken: 1,
      identity: 1,
      registryIdentity: 1,
      workspaceIdentity: 1,
    });
  });

  it("rejects non-primitive and non-canonical values at every external write boundary", async () => {
    expect(() => createSkillResourceAllocationLedger([] as never)).toThrow("Invalid");
    expect(() => createSkillResourceAllocationLedger({ databaseOptions: [] } as never)).toThrow(
      "Invalid",
    );
    expect(() =>
      createSkillResourceAllocationLedger({
        databaseOptions: { path: "bad\0path" },
      }),
    ).toThrow("Invalid");
    expect(() =>
      createSkillResourceAllocationLedger({ incarnationId: [incarnationId] } as never),
    ).toThrow("Invalid");

    const { ledger } = createFixture();
    for (const invalid of [
      { ...intent, allocationId: [allocationId] },
      { ...intent, allocationId: Object(allocationId) },
      { ...intent, environmentId: ["environment-1"] },
      { ...intent, environmentId: " environment-1" },
      { ...intent, environmentId: "environment\n1" },
      { ...intent, ownerEpoch: Object(7) },
      { ...intent, workspace: Object(intent.workspace) },
      { ...intent, workspace: "/remote/../workspace" },
      { ...intent, workspace: "/remote/workspace\0alias" },
      { ...intent, leaseToken: [leaseToken] },
    ]) {
      await expect(ledger.createIntent(invalid as never)).rejects.toThrow(
        "Invalid skill resource allocation intent",
      );
    }
    const created = await ledger.createIntent(intent);
    await expect(
      ledger.markAllocated([allocationId] as never, created.revision, location),
    ).rejects.toThrow("Invalid skill resource allocation id");
    await expect(
      ledger.markAllocated(allocationId, [created.revision] as never, location),
    ).rejects.toThrow("Invalid skill resource allocation ledger revision");
    for (const [field, value] of [
      ["identity", Object("1:2")],
      ["registryIdentity", ["3:4"]],
      ["workspaceIdentity", { value: "5:6" }],
    ] as const) {
      await expect(
        ledger.markAllocated(allocationId, created.revision, {
          ...location,
          [field]: value,
        } as never),
      ).rejects.toThrow("Invalid skill resource allocation location");
    }
    await expect(ledger.list()).resolves.toEqual([created]);
  });

  it("quarantines malformed and unsafe-timestamp rows without hiding valid allocations", async () => {
    const { databasePath, ledger } = createFixture();
    const created = await ledger.createIntent(intent);
    const malformedId = "4".repeat(32);
    const invalidKey = "not-an-allocation-id";
    const unsafeTimestampId = "5".repeat(32);
    const unsafeTimestamp = 9_007_199_254_740_993n;
    writeRawLease(databasePath, {
      leaseKey: malformedId,
      payloadJson: "{",
    });
    writeRawLease(databasePath, {
      leaseKey: invalidKey,
      payloadJson: "{}",
    });
    writeRawLease(databasePath, {
      leaseKey: unsafeTimestampId,
      payloadJson: JSON.stringify(rawRecord({ allocationId: unsafeTimestampId })),
      createdAt: unsafeTimestamp,
      updatedAt: unsafeTimestamp,
    });

    await expect(ledger.list()).resolves.toEqual([created]);
    const rows = readScopeRows(databasePath);
    expect(rows.map((row) => row.lease_key)).toContain(allocationId);
    expect(rows.map((row) => row.lease_key)).not.toContain(malformedId);
    expect(rows.map((row) => row.lease_key)).not.toContain(invalidKey);
    expect(rows.map((row) => row.lease_key)).not.toContain(unsafeTimestampId);
    expect(quarantineRows(databasePath)).toHaveLength(3);

    const unsafeEvidence = quarantineRows(databasePath)
      .map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>)
      .find(
        (envelope) => (envelope.original as Record<string, unknown>).leaseKey === unsafeTimestampId,
      );
    expect(unsafeEvidence).toMatchObject({
      version: 1,
      original: {
        scope: ledgerScope,
        leaseKey: unsafeTimestampId,
        owner: incarnationId,
        expiresAt: null,
        heartbeatAt: null,
        payloadJson: JSON.stringify(rawRecord({ allocationId: unsafeTimestampId })),
        createdAt: unsafeTimestamp.toString(),
        updatedAt: unsafeTimestamp.toString(),
      },
    });
  });

  it("cross-validates owner, nullability, payload, and table timestamps", async () => {
    const { databasePath, ledger } = createFixture();
    const created = await ledger.createIntent(intent);
    const corruptRows: RawLeaseOverrides[] = [
      {
        leaseKey: "4".repeat(32),
        owner: "8".repeat(32),
        payloadJson: JSON.stringify(rawRecord({ allocationId: "4".repeat(32) })),
      },
      {
        leaseKey: "5".repeat(32),
        expiresAt: 50,
        payloadJson: JSON.stringify(rawRecord({ allocationId: "5".repeat(32) })),
      },
      {
        leaseKey: "6".repeat(32),
        heartbeatAt: 50,
        payloadJson: JSON.stringify(rawRecord({ allocationId: "6".repeat(32) })),
      },
      {
        leaseKey: "7".repeat(32),
        payloadJson: JSON.stringify(rawRecord({ allocationId: "7".repeat(32) })),
        createdAt: 9,
      },
      {
        leaseKey: "8".repeat(32),
        payloadJson: null,
      },
    ];
    for (const row of corruptRows) {
      writeRawLease(databasePath, row);
    }

    await expect(ledger.list()).resolves.toEqual([created]);
    expect(quarantineRows(databasePath)).toHaveLength(corruptRows.length);
  });

  it("leaves foreign scopes, including differently cased scopes, untouched", async () => {
    const { databasePath, ledger } = createFixture();
    const created = await ledger.createIntent(intent);
    const foreignScope = "WORKER.SKILL-RESOURCE-ALLOCATION.V1";
    const foreignPayload = "{";
    writeRawLease(databasePath, {
      scope: foreignScope,
      payloadJson: foreignPayload,
    });

    await expect(ledger.list()).resolves.toEqual([created]);
    expect(readScopeRows(databasePath, foreignScope)).toMatchObject([
      {
        scope: foreignScope,
        lease_key: allocationId,
        payload_json: foreignPayload,
      },
    ]);
  });

  it("commits quarantine before reporting corruption on an exact transition", async () => {
    const { databasePath, ledger } = createFixture();
    openOpenClawStateDatabase({ path: databasePath });
    writeRawLease(databasePath, { payloadJson: "{" });

    await expect(ledger.markCleanupPending(allocationId, 1)).rejects.toThrow(
      "Corrupt skill resource allocation ledger record quarantined",
    );
    expect(readScopeRows(databasePath).map((row) => row.lease_key)).not.toContain(allocationId);
    expect(quarantineRows(databasePath)).toHaveLength(1);
  });

  it("rechecks ownership immediately before each corrupt-row quarantine mutation", async () => {
    const { databasePath, ledger } = createFixture();
    openOpenClawStateDatabase({ path: databasePath });
    writeRawLease(databasePath, { payloadJson: "{" });
    let fenceCalls = 0;
    const fence = vi.fn(() => {
      fenceCalls += 1;
      if (fenceCalls === 2) {
        throw new Error("ownership changed before quarantine");
      }
    });

    await expect(ledger.list(fence)).rejects.toThrow("ownership changed before quarantine");
    expect(readScopeRows(databasePath).map((row) => row.lease_key)).toContain(allocationId);
    expect(quarantineRows(databasePath)).toHaveLength(0);
    await expect(ledger.list()).resolves.toEqual([]);
    expect(quarantineRows(databasePath)).toHaveLength(1);
  });

  it("keeps quarantine time monotonic when the host wall clock moves backward", async () => {
    const { databasePath, ledger } = createFixture();
    openOpenClawStateDatabase({ path: databasePath });
    writeRawLease(databasePath, {
      leaseKey: "4".repeat(32),
      payloadJson: "{",
      createdAt: 11,
      updatedAt: 11,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(10);
    try {
      await expect(ledger.list()).resolves.toEqual([]);
    } finally {
      clock.mockRestore();
    }
    expect(quarantineRows(databasePath)).toMatchObject([{ created_at: 11n, updated_at: 11n }]);
  });

  it("quarantines every impossible phase, revision, and location combination", async () => {
    const { databasePath, ledger } = createFixture();
    await ledger.createIntent(intent);
    const impossible = [
      { phase: "intent", revision: 2, location: null },
      { phase: "intent", revision: 1, location },
      { phase: "allocated", revision: 1, location },
      { phase: "allocated", revision: 2, location: null },
      { phase: "allocated", revision: 3, location },
      { phase: "cleanup-pending", revision: 1, location: null },
      { phase: "cleanup-pending", revision: 2, location },
      { phase: "cleanup-pending", revision: 3, location: null },
      { phase: "cleanup-pending", revision: 4, location },
      { phase: "cleanup-complete", revision: 2, location: null },
      { phase: "cleanup-complete", revision: 3, location },
      { phase: "cleanup-complete", revision: 4, location: null },
      { phase: "cleanup-complete", revision: 5, location },
    ] as const;
    for (const [index, state] of impossible.entries()) {
      const id = (index + 4).toString(16).repeat(32);
      writeRawLease(databasePath, {
        leaseKey: id,
        payloadJson: JSON.stringify(rawRecord({ ...state, allocationId: id } as never)),
      });
    }

    await expect(ledger.list()).resolves.toMatchObject([{ allocationId, phase: "intent" }]);
    expect(quarantineRows(databasePath)).toHaveLength(impossible.length);
  });

  it("quarantines a record whose payload allocation does not match its row key", async () => {
    const { databasePath, ledger } = createFixture();
    openOpenClawStateDatabase({ path: databasePath });
    const rowId = "4".repeat(32);
    const payloadId = "5".repeat(32);
    writeRawLease(databasePath, {
      leaseKey: rowId,
      payloadJson: JSON.stringify(rawRecord({ allocationId: payloadId })),
    });

    await expect(ledger.list()).resolves.toEqual([]);
    expect(quarantineRows(databasePath)).toHaveLength(1);
  });

  it("preserves outstanding cleanup across a live database close and source-update boundary", async () => {
    const { ledger, stateDir } = createFixture();
    const created = await ledger.createIntent(intent);
    const pending = await ledger.markCleanupPending(allocationId, created.revision);
    closeOpenClawStateDatabaseForTest();

    const replacementBinary = createFixture({ incarnation: "4".repeat(32), stateDir }).ledger;
    await expect(replacementBinary.list()).resolves.toEqual([pending]);
  });

  it("preserves its scoped rows while upgrading shared schema version 11", async () => {
    const { databasePath, ledger } = createFixture();
    const created = await ledger.createIntent(intent);
    closeOpenClawStateDatabaseForTest();
    const older = new DatabaseSync(databasePath);
    try {
      older.exec(STATE_SCHEMA_12_TO_11_DOWNGRADE_SQL);
    } finally {
      older.close();
    }

    await expect(ledger.list()).resolves.toEqual([created]);
    const upgraded = openOpenClawStateDatabase({ path: databasePath });
    expect(upgraded.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });

  it("fails closed without writing when the shared database uses a future schema", async () => {
    const { databasePath, ledger } = createFixture();
    openOpenClawStateDatabase({ path: databasePath });
    closeOpenClawStateDatabaseForTest();
    const future = new DatabaseSync(databasePath);
    try {
      future.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    } finally {
      future.close();
    }

    await expect(ledger.createIntent(intent)).rejects.toThrow(
      `newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
    );
    const inspect = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        inspect
          .prepare("SELECT COUNT(*) AS count FROM state_leases WHERE scope = ?")
          .get(ledgerScope),
      ).toEqual({ count: 0 });
    } finally {
      inspect.close();
    }
  });
});
