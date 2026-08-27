// SQLite workspace state tests cover persistence, monotonic setup completion,
// and atomic attestation hash replacement.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  deleteWorkspaceState,
  mergeWorkspaceSetupState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
} from "./workspace-state-store.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-store-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

function workspaceDir(): string {
  if (!testState) {
    throw new Error("test state unavailable");
  }
  return testState.workspaceDir;
}

function deleteState(targetDir: string): void {
  deleteWorkspaceState(prepareWorkspaceStateDeletion(targetDir));
}

function insertPersistedAttestationHash(filename: string, sha256: string): void {
  const identity = resolveWorkspaceStateIdentity(workspaceDir());
  const db = openOpenClawStateDatabase().db;
  db.prepare(
    "INSERT INTO workspace_attestations (workspace_key, attested_at_ms, updated_at_ms) VALUES (?, 1, 1)",
  ).run(identity.workspaceKey);
  db.prepare(
    "INSERT INTO workspace_generated_bootstrap_hashes (workspace_key, filename, sha256) VALUES (?, ?, ?)",
  ).run(identity.workspaceKey, filename, sha256);
}

describe("workspace state store", () => {
  it("does not create shared state for a read-only snapshot", () => {
    const statePath = resolveOpenClawStateSqlitePath(testState!.env);
    expect(fs.existsSync(statePath)).toBe(false);

    expect(
      readWorkspaceStateSnapshot(workspaceDir(), {
        env: testState!.env,
        readOnly: true,
      }),
    ).toMatchObject({ setupExists: false, setup: { version: 1 } });
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("round-trips setup and attestation state after a database restart", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, {
      bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
      setupCompletedAt: "2026-07-16T02:00:00.000Z",
    });
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_752_628_800_000,
      generatedHashes: new Map([
        ["AGENTS.md", "a".repeat(64)],
        ["TOOLS.md", "b".repeat(64)],
      ]),
    });

    closeOpenClawStateDatabaseForTest();

    const snapshot = readWorkspaceStateSnapshot(dir);
    expect(snapshot.setupExists).toBe(true);
    expect(snapshot.setup).toStrictEqual({
      version: 1,
      bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
      setupCompletedAt: "2026-07-16T02:00:00.000Z",
    });
    expect(snapshot.attestation?.attestedAtMs).toBe(1_752_628_800_000);
    expect([...snapshot.attestation!.generatedHashes.entries()]).toStrictEqual([
      ["AGENTS.md", "a".repeat(64)],
      ["TOOLS.md", "b".repeat(64)],
    ]);
  });

  it.each(["HEARTBEAT.md", "RETIRED.md"])(
    "reads a persisted hash for a retired or unknown bootstrap filename: %s",
    (filename) => {
      insertPersistedAttestationHash(filename, "a".repeat(64));

      expect([
        ...readWorkspaceStateSnapshot(workspaceDir()).attestation!.generatedHashes.entries(),
      ]).toStrictEqual([[filename, "a".repeat(64)]]);
    },
  );

  it.each([
    "../AGENTS.md",
    "nested\\AGENTS.md",
    "C:outside.md",
    "NUL.md",
    "com1.md",
    "CON.md",
    "COM¹.md",
    "CONIN$.md",
    "CONOUT$.md",
    ".hidden.md",
  ])("rejects an unsafe persisted attestation filename: %s", (filename) => {
    insertPersistedAttestationHash(filename, "a".repeat(64));

    expect(() => readWorkspaceStateSnapshot(workspaceDir())).toThrow(
      "workspace attestation hash row is invalid",
    );
  });

  it("rejects a malformed persisted attestation hash", () => {
    insertPersistedAttestationHash("AGENTS.md", "a".repeat(63));

    expect(() => readWorkspaceStateSnapshot(workspaceDir())).toThrow(
      "workspace attestation hash row is invalid",
    );
  });

  it("never regresses persisted setup milestones", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    mergeWorkspaceSetupState(dir, { setupCompletedAt: "2026-07-16T02:00:00.000Z" }, 2_000);
    const state = mergeWorkspaceSetupState(
      dir,
      {
        bootstrapSeededAt: "2026-07-16T03:00:00.000Z",
        setupCompletedAt: "2026-07-16T04:00:00.000Z",
      },
      3_000,
    );

    expect(state).toStrictEqual({
      version: 1,
      bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
      setupCompletedAt: "2026-07-16T02:00:00.000Z",
    });
    expect(readWorkspaceStateSnapshot(dir).setup).toStrictEqual(state);
  });

  it("replaces generated hashes atomically and ignores older attestations", () => {
    const dir = workspaceDir();
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 2_000,
      generatedHashes: new Map([
        ["AGENTS.md", "a".repeat(64)],
        ["TOOLS.md", "b".repeat(64)],
      ]),
      nowMs: 2_000,
    });
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 3_000,
      generatedHashes: new Map([["SOUL.md", "c".repeat(64)]]),
      nowMs: 3_000,
    });
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_000,
      generatedHashes: new Map([["USER.md", "d".repeat(64)]]),
      nowMs: 4_000,
    });

    const attestation = readWorkspaceStateSnapshot(dir).attestation;
    expect(attestation?.attestedAtMs).toBe(3_000);
    expect([...attestation!.generatedHashes.entries()]).toStrictEqual([
      ["SOUL.md", "c".repeat(64)],
    ]);
  });

  it("replaces a future-dated attestation with a live refresh", () => {
    const dir = workspaceDir();
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 100_000,
      generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
      nowMs: 100_000,
    });

    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 2_000,
      generatedHashes: new Map([["TOOLS.md", "b".repeat(64)]]),
      nowMs: 2_000,
    });

    const attestation = readWorkspaceStateSnapshot(dir).attestation;
    expect(attestation?.attestedAtMs).toBe(2_000);
    expect([...attestation!.generatedHashes.entries()]).toStrictEqual([
      ["TOOLS.md", "b".repeat(64)],
    ]);
  });

  it("preserves future-dated state for a vanished workspace", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 100_000,
      generatedHashes: new Map(),
      nowMs: 100_000,
    });

    expect(clearExpiredWorkspaceStateForVanishedWorkspace(dir, 2_000)).toBe(false);
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(dir).attestation?.attestedAtMs).toBe(100_000);
  });

  it("preserves recent setup-only state for a vanished workspace", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);

    expect(clearExpiredWorkspaceStateForVanishedWorkspace(dir, 2_000)).toBe(false);
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(true);
  });

  it("keeps symlink aliases on one identity after the workspace target vanishes", () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const identity = resolveWorkspaceStateIdentity(dir);

    expect(resolveWorkspaceStateIdentity(alias)).toStrictEqual(identity);
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    fs.rmSync(dir, { recursive: true, force: true });

    expect(resolveWorkspaceStateIdentity(alias)).toStrictEqual(identity);
    expect(clearExpiredWorkspaceStateForVanishedWorkspace(alias, 2_000)).toBe(false);
    expect(readWorkspaceStateSnapshot(alias).setupExists).toBe(true);
  });

  it("uses a persisted alias after the configured symlink itself disappears", () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const identity = resolveWorkspaceStateIdentity(dir);
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);

    fs.unlinkSync(alias);

    expect(resolveWorkspaceStateIdentity(alias)).not.toStrictEqual(identity);
    expect(readWorkspaceStateSnapshot(alias).identity).toStrictEqual(identity);
    expect(clearExpiredWorkspaceStateForVanishedWorkspace(alias, 2_000)).toBe(false);
  });

  it("registers missing aliases in the caller-selected state database", () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: testState!.path("custom-state"),
    };
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const identity = resolveWorkspaceStateIdentity(dir);
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000, {
      env,
    });

    expect(readWorkspaceStateSnapshot(alias, { env }).identity).toStrictEqual(identity);
    fs.unlinkSync(alias);

    expect(readWorkspaceStateSnapshot(alias, { env }).identity).toStrictEqual(identity);
    expect(readWorkspaceStateSnapshot(alias, { env }).setupExists).toBe(true);
    expect(resolveOpenClawStateSqlitePath(env)).not.toBe(resolveOpenClawStateSqlitePath());
    expect(readWorkspaceStateSnapshot(alias).setupExists).toBe(false);
  });

  it("does not register missing aliases through a read-only database", async () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: testState!.path("custom-state"),
    };
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000, {
      env,
    });
    closeOpenClawStateDatabaseForTest();
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    const database = await openExistingOpenClawStateDatabaseReadOnly({ env });
    if (!database) {
      throw new Error("expected read-only database");
    }

    try {
      expect(readWorkspaceStateSnapshot(alias, { database, env, readOnly: true }).setupExists).toBe(
        true,
      );
    } finally {
      database.walMaintenance.close();
    }
    fs.unlinkSync(alias);

    expect(readWorkspaceStateSnapshot(alias, { env }).setupExists).toBe(false);
  });

  it("fails closed when a persisted symlink alias is repointed", () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    expect(() => readWorkspaceStateSnapshot(alias)).toThrow(/different current target/u);
  });

  it("cleans current state and only the stale association for a repointed alias", () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    mergeWorkspaceSetupState(replacement, { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" }, 2_000);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    const deletion = prepareWorkspaceStateDeletion(alias);
    fs.unlinkSync(alias);
    deleteWorkspaceState(deletion);

    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(replacement).setupExists).toBe(false);
    const staleAlias = openOpenClawStateDatabase()
      .db.prepare("SELECT alias_key FROM workspace_path_aliases WHERE alias_path = ?")
      .get(alias);
    expect(staleAlias).toBeUndefined();
  });

  it("deletes canonical state through a missing persisted alias", () => {
    const dir = workspaceDir();
    const alias = testState!.path("workspace-link");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    fs.unlinkSync(alias);

    deleteState(alias);

    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(false);
    const aliases = openOpenClawStateDatabase()
      .db.prepare("SELECT alias_key FROM workspace_path_aliases")
      .all();
    expect(aliases).toEqual([]);
  });

  it("clears expired setup-only state for a vanished workspace", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);

    expect(clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001)).toBe(true);
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(false);
  });

  it("does not protect a markerless setup row", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, {}, 1_000);

    expect(clearExpiredWorkspaceStateForVanishedWorkspace(dir, 2_000)).toBe(true);
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(false);
  });

  it("preserves recent setup state when its attestation is stale", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, { setupCompletedAt: "2026-07-16T01:00:00.000Z" }, 100_000_000);
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_000,
      generatedHashes: new Map(),
      nowMs: 1_000,
    });

    expect(clearExpiredWorkspaceStateForVanishedWorkspace(dir, 100_001_000)).toBe(false);
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(true);
  });

  it("deletes future-version state without parsing it", () => {
    const dir = workspaceDir();
    const identity = resolveWorkspaceStateIdentity(dir);
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      `INSERT INTO workspace_setup_state (
        workspace_key,
        workspace_path,
        version,
        bootstrap_seeded_at,
        setup_completed_at,
        updated_at
      ) VALUES (?, ?, 99, NULL, NULL, 1)`,
    ).run(identity.workspaceKey, identity.workspacePath);

    expect(() => readWorkspaceStateSnapshot(dir)).toThrow(/version requires openclaw doctor/u);
    expect(() => deleteState(dir)).not.toThrow();
    const row = db
      .prepare("SELECT workspace_key FROM workspace_setup_state WHERE workspace_key = ?")
      .get(identity.workspaceKey);
    expect(row).toBeUndefined();
  });

  it("does not recreate a missing database during delete-only cleanup", () => {
    const dir = workspaceDir();
    const databasePath = resolveOpenClawStateSqlitePath();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(path.dirname(databasePath), { recursive: true, force: true });

    deleteState(dir);

    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.existsSync(path.dirname(databasePath))).toBe(false);
  });

  it("deletes migration receipts owned by the workspace", () => {
    const dir = workspaceDir();
    const identity = resolveWorkspaceStateIdentity(dir);
    const db = openOpenClawStateDatabase().db;
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" });
    const insertRun = db.prepare(
      "INSERT INTO migration_runs (id, started_at, finished_at, status, report_json) VALUES (?, 1, 1, 'completed', '{}')",
    );
    insertRun.run("owned-run");
    insertRun.run("unrelated-run");
    const insertReceipt = db.prepare(
      `INSERT INTO migration_sources (
        source_key,
        migration_kind,
        source_path,
        target_table,
        last_run_id,
        status,
        imported_at,
        report_json
      ) VALUES (?, ?, ?, 'workspace_setup_state', ?, 'completed', 1, ?)`,
    );
    insertReceipt.run(
      "owned-receipt",
      WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
      path.join(dir, ".openclaw", "workspace-state.json"),
      "owned-run",
      JSON.stringify({ workspaceKey: identity.workspaceKey }),
    );
    insertReceipt.run(
      "unrelated-receipt",
      WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
      "/other/workspace-state.json",
      "unrelated-run",
      JSON.stringify({ workspaceKey: "other-workspace" }),
    );

    deleteState(dir);

    const receipts = db
      .prepare("SELECT source_key FROM migration_sources ORDER BY source_key")
      .all();
    expect(receipts).toEqual([{ source_key: "unrelated-receipt" }]);
    const runs = db.prepare("SELECT id FROM migration_runs ORDER BY id").all();
    expect(runs).toEqual([{ id: "unrelated-run" }]);
  });

  it("clears expired missing-workspace state but preserves a concurrent refresh", () => {
    const dir = workspaceDir();
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 1_000,
      generatedHashes: new Map(),
      nowMs: 1_000,
    });

    expect(clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001)).toBe(true);
    expect(readWorkspaceStateSnapshot(dir)).toMatchObject({ setupExists: false });
    expect(readWorkspaceStateSnapshot(dir).attestation).toBeUndefined();

    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" }, 86_401_000);
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs: 86_401_000,
      generatedHashes: new Map(),
      nowMs: 86_401_000,
    });
    expect(clearExpiredWorkspaceStateForVanishedWorkspace(dir, 86_401_001)).toBe(false);
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(true);
  });
});
