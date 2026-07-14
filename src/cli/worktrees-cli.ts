import type { Command } from "commander";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { managedWorktrees, resolveWorktreeCleanupLimits } from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { isManagedWorktreeOwnerActive } from "../gateway/worktree-owner-activity.js";
import { defaultRuntime } from "../runtime.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type JsonOption = { json?: boolean };

function printJson(value: unknown): void {
  // writeJson targets process.stdout directly; runtime.log routes through the console
  // logger and never reaches piped stdout, which breaks `--json | jq` consumers.
  defaultRuntime.writeJson(value);
}

function printRecord(record: ManagedWorktreeRecord, json: boolean): void {
  if (json) {
    printJson(record);
    return;
  }
  defaultRuntime.log(`${record.id}\t${record.path}`);
}

export function registerWorktreesCli(program: Command): void {
  const worktrees = program
    .command("worktrees")
    .description("Create, inspect, restore, and clean up managed worktrees");

  worktrees
    .command("list")
    .description("List active and restorable managed worktrees")
    .option("--json", "Output JSON", false)
    .action(async (opts: JsonOption) => {
      const records = await managedWorktrees.list();
      if (opts.json) {
        printJson({ worktrees: records });
        return;
      }
      if (records.length === 0) {
        defaultRuntime.log("No managed worktrees.");
        return;
      }
      defaultRuntime.log(
        renderTable({
          width: getTerminalTableWidth(),
          columns: [
            { key: "ID", header: "ID", minWidth: 16, flex: true },
            { key: "Repo", header: "Repo", minWidth: 18, flex: true },
            { key: "Branch", header: "Branch", minWidth: 18, flex: true },
            { key: "Status", header: "Status", minWidth: 10 },
          ],
          rows: records.map((record) => ({
            ID: record.id,
            Repo: record.repoRoot,
            Branch: record.branch,
            Status: record.removedAt ? "restorable" : "active",
          })),
        }).trimEnd(),
      );
    });

  worktrees
    .command("create")
    .description("Create a managed worktree")
    .argument("<repoRoot>", "Source git checkout")
    .option("--name <name>", "Managed worktree name")
    .option("--base-ref <ref>", "Git ref to branch from")
    .option("--json", "Output JSON", false)
    .action(async (repoRoot: string, opts: JsonOption & { name?: string; baseRef?: string }) => {
      printRecord(
        await managedWorktrees.create({
          repoRoot,
          name: opts.name,
          baseRef: opts.baseRef,
          ownerKind: "manual",
        }),
        opts.json === true,
      );
    });

  worktrees
    .command("remove")
    .description("Snapshot and remove a managed worktree")
    .argument("<id>", "Managed worktree id")
    .option("--force", "Remove even if snapshot creation fails", false)
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: JsonOption & { force?: boolean }) => {
      const result = await managedWorktrees.remove({
        id,
        reason: "manual-delete",
        force: opts.force,
      });
      if (opts.json) {
        printJson(result);
      } else {
        defaultRuntime.log(
          result.snapshotError
            ? `Removed ${id} without a snapshot: ${result.snapshotError}`
            : `Removed ${id}.`,
        );
      }
    });

  worktrees
    .command("restore")
    .description("Restore a managed worktree from its snapshot")
    .argument("<id>", "Managed worktree id")
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: JsonOption) => {
      printRecord(await managedWorktrees.restore({ id }), opts.json === true);
    });

  worktrees
    .command("gc")
    .description("Run managed worktree cleanup now")
    .option("--json", "Output JSON", false)
    .action(async (opts: JsonOption) => {
      const limits = resolveWorktreeCleanupLimits(getRuntimeConfig().worktrees);
      const result = await managedWorktrees.gc({
        limits,
        isOwnerActive: isManagedWorktreeOwnerActive,
      });
      if (opts.json) {
        printJson(result);
      } else {
        defaultRuntime.log(
          `Removed ${result.removed.length}; deleted ${result.orphansDeleted} orphans; pruned ${result.snapshotsPruned} snapshots.`,
        );
      }
    });

  applyParentDefaultHelpAction(worktrees);
}
