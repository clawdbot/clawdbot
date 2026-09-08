import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspaceStateIdentity,
  resolveWorkspaceStateIdentity,
} from "../agents/workspace-state-identity.js";
import {
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
} from "../agents/workspace-state-store.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  applyWorkspaceMigrationReceiptMove,
  createWorkspaceSetupFingerprint,
  prepareWorkspaceMigrationReceiptMove,
} from "./state-migrations.workspace-setup-receipts.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

describe("workspace migration receipt move", () => {
  const { setup } = useWorkspaceMigrationTestFixture();

  function fixture() {
    const context = setup();
    const storedIdentity = resolveWorkspaceStateIdentity(context.workspaceDir);
    const currentIdentity = createWorkspaceStateIdentity(
      path.join(path.dirname(storedIdentity.workspacePath), "moved-workspace"),
    );
    fs.renameSync(context.workspaceDir, currentIdentity.workspacePath);
    const { db } = openOpenClawStateDatabase({ env: context.env });
    const storedSetup = {
      version: 1,
      workspace_path: storedIdentity.workspacePath,
      bootstrap_seeded_at: "2026-07-15T10:00:00.000Z",
      setup_completed_at: "2026-07-15T10:01:00.000Z",
    };
    const sourcePath = path.join(storedIdentity.workspacePath, "openclaw-workspace-state.json");
    const receipt = {
      sourceKey: resolveLegacyMigrationSourceKey(
        "workspace-setup",
        sourcePath,
        storedIdentity.workspaceKey,
      ),
      migrationKind: WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
      sourcePath,
      targetTable: "workspace_setup_state",
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 10,
      sourceRecordCount: 1,
      runId: "setup-import",
      now: 1000,
      reportJson: JSON.stringify({
        sourceKind: "setup",
        workspaceKey: storedIdentity.workspaceKey,
        canonicalFingerprint: createWorkspaceSetupFingerprint(storedSetup),
        authoritative: true,
        resolution: "inserted",
      }),
    };
    runOpenClawStateWriteTransaction(
      ({ db: writeDatabase }) => {
        recordLegacyMigrationReceipt(writeDatabase, receipt);
        writeDatabase
          .prepare("UPDATE migration_sources SET removed_source = 1 WHERE source_key = ?")
          .run(receipt.sourceKey);
      },
      { env: context.env },
    );
    const params = {
      database: db,
      storedIdentity,
      currentIdentity,
      storedSetup,
      currentDirectoryPath: currentIdentity.workspacePath,
    };
    const rows = () => db.prepare("SELECT * FROM migration_sources ORDER BY source_key").all();
    return { ...context, ...params, db, receipt, params, rows };
  }

  it.each(["changed", "added", "destination collision"] as const)(
    "refuses %s receipts without applying a partial move",
    async (change) => {
      const value = fixture();
      const plan = await prepareWorkspaceMigrationReceiptMove(value.params);
      if (change === "changed") {
        value.db
          .prepare("UPDATE migration_sources SET removed_source = 0 WHERE source_key = ?")
          .run(value.receipt.sourceKey);
      } else {
        const sourcePath =
          change === "added"
            ? path.join(value.storedIdentity.workspacePath, ".openclaw", "workspace-state.json")
            : path.join(value.currentIdentity.workspacePath, "openclaw-workspace-state.json");
        const owner = change === "added" ? value.storedIdentity : value.currentIdentity;
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            recordLegacyMigrationReceipt(db, {
              ...value.receipt,
              sourcePath,
              sourceKey: resolveLegacyMigrationSourceKey(
                "workspace-setup",
                sourcePath,
                owner.workspaceKey,
              ),
              runId: "concurrent-import",
              reportJson: JSON.stringify({
                ...JSON.parse(value.receipt.reportJson),
                workspaceKey: owner.workspaceKey,
              }),
            }),
          { env: value.env },
        );
      }
      const before = value.rows();
      expect(() =>
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare("UPDATE migration_runs SET status = 'moving' WHERE id = ?").run(
              value.receipt.runId,
            );
            applyWorkspaceMigrationReceiptMove(db, plan);
          },
          { env: value.env },
        ),
      ).toThrow("migration history changed");
      expect(value.rows()).toEqual(before);
      expect(
        value.db.prepare("SELECT status FROM migration_runs WHERE id = ?").get(value.receipt.runId),
      ).toEqual({ status: "completed" });
    },
  );

  it.each(["prepared", "completed", "superseded"])(
    "keeps %s skill-relocation evidence under its lifecycle owner",
    async (status) => {
      const value = fixture();
      const sourceKey = resolveLegacyMigrationSourceKey(
        WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
        value.storedIdentity.workspacePath,
      );
      const report = {
        ...value.storedIdentity,
        workspaceDir: value.storedIdentity.workspacePath,
        directoryIdentity: "1:2:3",
        attestedAtMs: 1000,
        moves: [
          {
            source: path.join(value.storedIdentity.workspacePath, "skills", "local-skill"),
            destination: path.join(value.homeDir, "workshop"),
            sha256: "b".repeat(64),
          },
        ],
      };
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          recordLegacyMigrationReceipt(db, {
            ...value.receipt,
            sourceKey,
            sourcePath: value.storedIdentity.workspacePath,
            migrationKind: WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
            runId: "skill-relocation",
            reportJson: JSON.stringify(report),
          });
          db.prepare("UPDATE migration_sources SET status = ? WHERE source_key = ?").run(
            status,
            sourceKey,
          );
        },
        { env: value.env },
      );
      const before = value.rows();
      const runs = value.db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
      if (status === "prepared") {
        await expect(prepareWorkspaceMigrationReceiptMove(value.params)).rejects.toThrow(
          "relocation is still pending",
        );
        expect(value.rows()).toEqual(before);
        return;
      }
      const plan = await prepareWorkspaceMigrationReceiptMove(value.params);
      runOpenClawStateWriteTransaction(({ db }) => applyWorkspaceMigrationReceiptMove(db, plan), {
        env: value.env,
      });
      const moved = value.db
        .prepare(
          "SELECT status, removed_source, report_json FROM migration_sources WHERE migration_kind = ?",
        )
        .get(WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND)!;
      expect(moved.status).toBe(status);
      expect(moved.removed_source).toBe(0);
      expect(JSON.parse(String(moved.report_json))).toEqual({
        ...report,
        workspaceKey: value.currentIdentity.workspaceKey,
      });
      expect(value.db.prepare("SELECT * FROM migration_runs ORDER BY id").all()).toEqual(runs);
    },
  );

  it("preserves an old unmatched fingerprint instead of granting it current authority", async () => {
    const value = fixture();
    const historical = {
      ...JSON.parse(value.receipt.reportJson),
      canonicalFingerprint: "b".repeat(64),
    };
    value.db
      .prepare("UPDATE migration_sources SET report_json = ? WHERE source_key = ?")
      .run(JSON.stringify(historical), value.receipt.sourceKey);
    const plan = await prepareWorkspaceMigrationReceiptMove(value.params);
    runOpenClawStateWriteTransaction(({ db }) => applyWorkspaceMigrationReceiptMove(db, plan), {
      env: value.env,
    });
    expect(JSON.parse(String(value.rows()[0]!.report_json))).toMatchObject({
      canonicalFingerprint: historical.canonicalFingerprint,
      authoritative: true,
    });
  });

  it.each(["unfinished", "reappeared"])(
    "refuses an %s external source without losing its cleanup evidence",
    async (kind) => {
      const value = fixture();
      const sourcePath = path.join(
        value.stateDir,
        "workspace-attestations",
        `${value.storedIdentity.workspaceKey}.attested`,
      );
      const sourceKey = resolveLegacyMigrationSourceKey(
        "workspace-attestation",
        sourcePath,
        value.storedIdentity.workspaceKey,
      );
      value.db
        .prepare(
          "UPDATE migration_sources SET source_key = ?, source_path = ?, removed_source = ?, report_json = ? WHERE source_key = ?",
        )
        .run(
          sourceKey,
          sourcePath,
          kind === "unfinished" ? 0 : 1,
          JSON.stringify({ ...JSON.parse(value.receipt.reportJson), sourceKind: "attestation" }),
          value.receipt.sourceKey,
        );
      if (kind === "reappeared") {
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(`${sourcePath}.doctor-importing`, "retained claim");
      }
      const before = value.rows();
      await expect(prepareWorkspaceMigrationReceiptMove(value.params)).rejects.toThrow(
        "external legacy source has not finished cleanup",
      );
      expect(value.rows()).toEqual(before);
    },
  );
});
