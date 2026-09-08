import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import * as backupSqliteSnapshot from "./backup-sqlite-snapshot.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

describe("backup legacy audit capture boundary", () => {
  it.each(["lease-duration overrun", "concurrent audit migration"] as const)(
    "restores audit records exactly once after %s during the SQLite snapshot",
    async (scenario) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "backup-audit-boundary-", scenario: "minimal" },
        async (state) => {
          const record = {
            ts: "2026-07-01T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "safe", "preserved-audit-record"],
            execArgv: [],
          };
          await state.writeText("logs/config-audit.jsonl", `${JSON.stringify(record)}\n`);
          const originalSnapshot = backupSqliteSnapshot.createBackupSqliteSnapshotPlan;
          const realNow = Date.now.bind(Date);
          const clock = vi.spyOn(Date, "now");
          let snapshotReached = false;
          const snapshot = vi
            .spyOn(backupSqliteSnapshot, "createBackupSqliteSnapshotPlan")
            .mockImplementationOnce(async (params) => {
              snapshotReached = true;
              if (scenario === "lease-duration overrun") {
                clock.mockImplementation(() => realNow() + 61_000);
              } else {
                const migrated = await migrateLegacyAuditLogs({
                  detected: detectLegacyAuditLogs({
                    stateDir: state.stateDir,
                    doctorOnlyStateMigrations: true,
                  }),
                  stateDir: state.stateDir,
                });
                expect(migrated.warnings).toEqual([]);
              }
              return await originalSnapshot(params);
            });
          try {
            const archive = await createBackupArchive({
              output: state.path("backup.tar.gz"),
              includeWorkspace: false,
            });
            expect(snapshotReached).toBe(true);
            clock.mockRestore();
            snapshot.mockRestore();
            const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
            const restored = await backupRestoreCommand(runtime, {
              archive: archive.archivePath,
              target: state.path("restored"),
            });
            const manifest = JSON.parse(
              await fs.readFile(
                path.join(restored.targetPath, archive.archiveRoot, "manifest.json"),
                "utf8",
              ),
            ) as { assets: Array<{ kind: string; archivePath: string }> };
            const stateAsset = expectDefined(
              manifest.assets.find((asset) => asset.kind === "state"),
              "restored state asset",
            );
            const restoredStateDir = path.join(restored.targetPath, stateAsset.archivePath);
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const migrated = await migrateLegacyAuditLogs({
                detected: detectLegacyAuditLogs({
                  stateDir: restoredStateDir,
                  doctorOnlyStateMigrations: true,
                }),
                stateDir: restoredStateDir,
              });
              expect(migrated.warnings).toEqual([]);
            }
            const records = createSqliteAuditRecordStore({
              scope: CONFIG_AUDIT_SCOPE,
              maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
              env: { ...state.env, OPENCLAW_STATE_DIR: restoredStateDir },
            }).entries();
            expect(records.map((entry) => entry.value)).toEqual([record]);
          } finally {
            clock.mockRestore();
            snapshot.mockRestore();
            closeOpenClawStateDatabase();
          }
        },
      );
    },
  );

  it("fails closed after bounded retries when the legacy source keeps changing", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "backup-audit-retry-", scenario: "minimal" },
      async (state) => {
        const sourcePath = path.join(state.stateDir, "logs/config-audit.jsonl");
        const outputPath = state.path("backup.tar.gz");
        await state.writeText(
          "logs/config-audit.jsonl",
          `${JSON.stringify({
            ts: "2026-07-01T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "safe", "initial"],
            execArgv: [],
          })}\n`,
        );
        const originalSnapshot = backupSqliteSnapshot.createBackupSqliteSnapshotPlan;
        let snapshotAttempts = 0;
        const snapshot = vi
          .spyOn(backupSqliteSnapshot, "createBackupSqliteSnapshotPlan")
          .mockImplementation(async (params) => {
            snapshotAttempts += 1;
            await fs.appendFile(
              sourcePath,
              `${JSON.stringify({
                ts: `2026-07-01T00:00:0${snapshotAttempts}.000Z`,
                source: "config-io",
                event: "config.write",
                argv: ["openclaw", "config", "set", "safe", `append-${snapshotAttempts}`],
                execArgv: [],
              })}\n`,
            );
            return await originalSnapshot(params);
          });
        try {
          await expect(
            createBackupArchive({ output: outputPath, includeWorkspace: false }),
          ).rejects.toThrow(/retry backup after legacy audit migration settles/iu);
          expect(snapshotAttempts).toBe(3);
          await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          snapshot.mockRestore();
          closeOpenClawStateDatabase();
        }
      },
    );
  });
});
