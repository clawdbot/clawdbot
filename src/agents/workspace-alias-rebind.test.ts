// Detection and non-destructive rebind of repointed workspace aliases.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "./workspace-alias-rebind.js";
import {
  resolveWorkspaceStateIdentity,
  WorkspaceAliasRepointedError,
} from "./workspace-state-identity.js";
import {
  mergeWorkspaceSetupState,
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
} from "./workspace-state-store.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-alias-rebind-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

describe("workspace alias rebind", () => {
  it("detects and rebinds a repointed alias without touching workspace files", () => {
    const dir = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.writeFileSync(path.join(replacement, "kept.txt"), "moved workspace content");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    replaceWorkspaceAttestation({
      workspaceDir: alias,
      attestedAtMs: 1_000,
      generatedHashes: new Map([["BOOTSTRAP.md", "a".repeat(64)]]),
      nowMs: 1_000,
    });
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    const facts = detectRepointedWorkspaceAlias(alias);
    expect(facts).toMatchObject({
      storedWorkspacePath: resolveWorkspaceStateIdentity(dir).workspacePath,
      currentWorkspacePath: resolveWorkspaceStateIdentity(replacement).workspacePath,
      currentTargetHasOwnState: false,
    });
    expect(facts?.storedAttestationHashes.get("BOOTSTRAP.md")).toBe("a".repeat(64));

    expect(rebindRepointedWorkspaceAlias(alias, facts!)).toBe("rebound");
    const snapshot = readWorkspaceStateSnapshot(alias);
    expect(snapshot.setupExists).toBe(true);
    expect(snapshot.setup.bootstrapSeededAt).toBe("2026-07-16T01:00:00.000Z");
    expect(snapshot.attestation?.generatedHashes.get("BOOTSTRAP.md")).toBe("a".repeat(64));
    expect(fs.readFileSync(path.join(replacement, "kept.txt"), "utf-8")).toBe(
      "moved workspace content",
    );

    expect(detectRepointedWorkspaceAlias(alias)).toBeUndefined();
    expect(rebindRepointedWorkspaceAlias(alias, facts!)).toBe("no-repoint");
  });

  it("refuses to rebind onto a target that already owns workspace state", () => {
    const dir = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    mergeWorkspaceSetupState(replacement, { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" }, 2_000);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    const facts = detectRepointedWorkspaceAlias(alias)!;
    expect(facts.currentTargetHasOwnState).toBe(true);
    expect(rebindRepointedWorkspaceAlias(alias, facts)).toBe("current-target-owns-state");
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(replacement).setupExists).toBe(true);
  });

  it("rejects a target change after doctor presents the repair facts", () => {
    const original = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const firstReplacement = testState!.path("replacement-a");
    const secondReplacement = testState!.path("replacement-b");
    fs.mkdirSync(firstReplacement, { recursive: true });
    fs.mkdirSync(secondReplacement, { recursive: true });
    fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    fs.unlinkSync(alias);
    fs.symlinkSync(firstReplacement, alias, process.platform === "win32" ? "junction" : "dir");
    const approvedFacts = detectRepointedWorkspaceAlias(alias)!;

    fs.unlinkSync(alias);
    fs.symlinkSync(secondReplacement, alias, process.platform === "win32" ? "junction" : "dir");

    expect(rebindRepointedWorkspaceAlias(alias, approvedFacts)).toBe("repoint-changed");
    expect(readWorkspaceStateSnapshot(original).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(secondReplacement).setupExists).toBe(false);
  });

  it("fails closed again when the alias is repointed after a committed rebind", () => {
    const original = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    const lateTarget = testState!.path("late-target");
    fs.mkdirSync(replacement, { recursive: true });
    fs.mkdirSync(lateTarget, { recursive: true });
    fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
    const facts = detectRepointedWorkspaceAlias(alias)!;
    expect(rebindRepointedWorkspaceAlias(alias, facts)).toBe("rebound");

    // A repoint racing the committed transfer cannot be adopted: state moved
    // only to the operator-approved target, and the guard re-engages for the
    // unapproved one instead of serving it.
    fs.unlinkSync(alias);
    fs.symlinkSync(lateTarget, alias, process.platform === "win32" ? "junction" : "dir");

    expect(() => readWorkspaceStateSnapshot(alias)).toThrow(WorkspaceAliasRepointedError);
    expect(readWorkspaceStateSnapshot(replacement).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(lateTarget).setupExists).toBe(false);
  });

  it("rejects malformed persisted attestation rows during detection", () => {
    const original = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    replaceWorkspaceAttestation({
      workspaceDir: alias,
      attestedAtMs: 1_000,
      generatedHashes: new Map([["BOOTSTRAP.md", "a".repeat(64)]]),
      nowMs: 1_000,
    });
    openOpenClawStateDatabase()
      .db.prepare("UPDATE workspace_generated_bootstrap_hashes SET filename = '../outside.md'")
      .run();
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    expect(() => detectRepointedWorkspaceAlias(alias)).toThrow(
      /workspace attestation hash row is invalid/u,
    );
  });

  it("transfers migration receipt ownership so later deletion removes it", () => {
    const original = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    const originalIdentity = resolveWorkspaceStateIdentity(original);
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "INSERT INTO migration_runs (id, started_at, finished_at, status, report_json) VALUES ('workspace-run', 1, 1, 'completed', '{}')",
    ).run();
    db.prepare(
      `INSERT INTO migration_sources (
        source_key, migration_kind, source_path, target_table, last_run_id, status, imported_at,
        report_json
      ) VALUES ('workspace-receipt', ?, '/legacy/workspace-state.json',
        'workspace_setup_state', 'workspace-run', 'completed', 1, ?)`,
    ).run(
      WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
      JSON.stringify({ workspaceKey: originalIdentity.workspaceKey }),
    );
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
    const facts = detectRepointedWorkspaceAlias(alias)!;

    expect(rebindRepointedWorkspaceAlias(alias, facts)).toBe("rebound");
    const receipt = db
      .prepare("SELECT report_json FROM migration_sources WHERE source_key = 'workspace-receipt'")
      .get() as { report_json: string };
    expect(JSON.parse(receipt.report_json)).toMatchObject({
      workspaceKey: resolveWorkspaceStateIdentity(replacement).workspaceKey,
    });

    deleteWorkspaceState(prepareWorkspaceStateDeletion(alias));
    expect(
      db
        .prepare("SELECT source_key FROM migration_sources WHERE source_key = 'workspace-receipt'")
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM migration_runs WHERE id = 'workspace-run'").get(),
    ).toBeUndefined();
  });
});
