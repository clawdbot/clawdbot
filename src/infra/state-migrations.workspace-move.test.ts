import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "../agents/workspace-alias-rebind.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readReceipt } from "./state-migrations.workspace-setup-receipts.js";
import { migrateLegacyWorkspaceState } from "./state-migrations.workspace-setup.js";
import { useWorkspaceMigrationTestFixture } from "./state-migrations.workspace-setup.test-support.js";

describe("workspace move migration recovery", () => {
  const { setup, detect, migrate } = useWorkspaceMigrationTestFixture();

  it.each([
    { interrupted: false, removeBackup: false, decomposed: false, originalDecomposed: false },
    { interrupted: true, removeBackup: false, decomposed: false, originalDecomposed: false },
    { interrupted: false, removeBackup: true, decomposed: false, originalDecomposed: false },
    { interrupted: false, removeBackup: false, decomposed: true, originalDecomposed: false },
    { interrupted: false, removeBackup: false, decomposed: false, originalDecomposed: true },
  ])(
    "preserves migration history after a move (interrupted: $interrupted, removed backup: $removeBackup, decomposed: $decomposed, original decomposed: $originalDecomposed)",
    async ({ interrupted, removeBackup, decomposed, originalDecomposed }) => {
      const context = setup();
      if (originalDecomposed) {
        const original = path.join(context.homeDir, "original-e\u0301");
        fs.renameSync(context.workspaceDir, original);
        context.workspaceDir = original;
      }
      const alias = path.join(context.homeDir, "workspace-alias");
      const moved = path.join(context.homeDir, decomposed ? "moved-e\u0301" : "moved-workspace");
      const link = () =>
        fs.symlinkSync(
          fs.existsSync(moved) ? moved : context.workspaceDir,
          alias,
          process.platform === "win32" ? "junction" : "dir",
        );
      link();
      const configured = {
        ...context,
        cfg: { agents: { defaults: { workspace: alias } } },
        workspaceDir: alias,
      };
      const milestones = {
        version: 1,
        bootstrapSeededAt: "2026-07-15T10:00:00.000Z",
        setupCompletedAt: "2026-07-15T10:01:00.000Z",
      };
      const raw = JSON.stringify(milestones);
      const sourcePath = path.join(context.workspaceDir, "openclaw-workspace-state.json");
      fs.writeFileSync(sourcePath, raw);
      const detected = detect(configured);
      const source = detected.sources.find((entry) => entry.kind === "setup")!;
      const imported = await migrateLegacyWorkspaceState({
        detected,
        env: context.env,
        stateDir: context.stateDir,
        ...(interrupted
          ? {
              removeSource: () => {
                throw new Error("interrupted cleanup");
              },
            }
          : {}),
      });
      expect(imported.warnings).toHaveLength(interrupted ? 1 : 0);
      const originalReceipt = readReceipt(source, context.env)!;
      expect(originalReceipt.removedSource).toBe(!interrupted);
      if (removeBackup) {
        fs.unlinkSync(originalReceipt.archivePath!);
      }
      const { db } = openOpenClawStateDatabase({ env: context.env });
      const runs = db.prepare("SELECT * FROM migration_runs ORDER BY id").all();

      fs.renameSync(context.workspaceDir, moved);
      fs.unlinkSync(alias);
      link();
      const facts = detectRepointedWorkspaceAlias(alias, { env: context.env })!;
      expect(await rebindRepointedWorkspaceAlias(alias, facts, { env: context.env })).toBe(
        "rebound",
      );

      const identity = resolveWorkspaceStateIdentity(moved);
      const movedSource = {
        ...source,
        sourcePath: path.join(moved, "openclaw-workspace-state.json"),
        rootDir: moved,
        workspaceDir: identity.workspacePath,
        workspaceKey: identity.workspaceKey,
      };
      const receipt = readReceipt(movedSource, context.env);
      expect(receipt).toMatchObject({
        sha256: originalReceipt.sha256,
        removedSource: !interrupted,
        archivePath: expect.stringContaining(moved),
      });
      expect(fs.existsSync(receipt!.archivePath!)).toBe(!removeBackup);
      if (!removeBackup) {
        expect(fs.readFileSync(receipt!.archivePath!, "utf8")).toBe(raw);
      }
      expect(db.prepare("SELECT * FROM migration_runs ORDER BY id").all()).toEqual(runs);
      expect(readWorkspaceStateSnapshot(alias).setup).toEqual(milestones);
      const row = db
        .prepare("SELECT report_json FROM migration_sources WHERE source_key = ?")
        .get(receipt!.sourceKey)!;
      expect(JSON.parse(String(row.report_json))).toMatchObject({
        authoritative: true,
        canonicalFingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              kind: "setup",
              workspacePath: identity.workspacePath,
              version: 1,
              bootstrapSeededAt: milestones.bootstrapSeededAt,
              setupCompletedAt: milestones.setupCompletedAt,
            }),
          )
          .digest("hex"),
      });

      expect((await migrate(configured)).warnings).toEqual([]);
      expect(readReceipt(movedSource, context.env)?.removedSource).toBe(true);
      expect(fs.existsSync(`${movedSource.sourcePath}.doctor-importing`)).toBe(false);
      expect(fs.existsSync(receipt!.archivePath!)).toBe(!removeBackup);

      // A removed source may have a later generation. The moved receipt must
      // preserve that distinction without replaying its replacement milestones.
      fs.writeFileSync(
        movedSource.sourcePath,
        JSON.stringify({ setupCompletedAt: "2026-07-16T00:00:00.000Z" }),
      );
      expect((await migrate(configured)).warnings).toEqual([]);
      expect(readWorkspaceStateSnapshot(alias).setup).toEqual(milestones);
      expect(readReceipt(movedSource, context.env)?.removedSource).toBe(true);
    },
  );
});
