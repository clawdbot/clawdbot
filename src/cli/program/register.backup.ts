// Backup command registration for local state archive creation and verification.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  backupSqliteCreateCommand,
  backupSqliteListCommand,
  backupSqliteRestoreCommand,
  backupSqliteVerifyCommand,
} from "../../commands/backup-sqlite.js";
import { backupVerifyCommand } from "../../commands/backup-verify.js";
import { backupCreateCommand } from "../../commands/backup.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

/** Register backup create/verify subcommands. */
export function registerBackupCommand(program: Command) {
  const backup = program
    .command("backup")
    .description("Create and verify backup archives and SQLite snapshots")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/backup", "docs.openclaw.ai/cli/backup")}\n`,
    );

  backup
    .command("create")
    .description("Write a backup archive for config, credentials, sessions, and workspaces")
    .option("--output <path>", "Archive path or destination directory")
    .option("--json", "Output JSON", false)
    .option("--dry-run", "Print the backup plan without writing the archive", false)
    .option("--verify", "Verify the archive after writing it", false)
    .option("--only-config", "Back up only the active JSON config file", false)
    .option("--no-include-workspace", "Exclude workspace directories from the backup")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw backup create", "Create a timestamped backup in the current directory."],
          [
            "openclaw backup create --output ~/Backups",
            "Write the archive into an existing backup directory.",
          ],
          [
            "openclaw backup create --dry-run --json",
            "Preview the archive plan without writing any files.",
          ],
          [
            "openclaw backup create --verify",
            "Create the archive and immediately validate its manifest and payload layout.",
          ],
          [
            "openclaw backup create --no-include-workspace",
            "Back up state/config without agent workspace files.",
          ],
          ["openclaw backup create --only-config", "Back up only the active JSON config file."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupCreateCommand(defaultRuntime, {
          output: opts.output as string | undefined,
          json: Boolean(opts.json),
          dryRun: Boolean(opts.dryRun),
          verify: Boolean(opts.verify),
          onlyConfig: Boolean(opts.onlyConfig),
          includeWorkspace: opts.includeWorkspace as boolean,
        });
      });
    });

  backup
    .command("verify <archive>")
    .description("Validate a backup archive and its embedded manifest")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup verify ./2026-03-09T08-00-00.000+08-00-openclaw-backup.tar.gz",
            "Check that the archive structure and manifest are intact.",
          ],
          [
            "openclaw backup verify ~/Backups/latest.tar.gz --json",
            "Emit machine-readable verification output.",
          ],
        ])}`,
    )
    .action(async (archive, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupVerifyCommand(defaultRuntime, {
          archive: archive as string,
          json: Boolean(opts.json),
        });
      });
    });

  registerBackupSqliteCommands(backup);
}

function registerBackupSqliteCommands(backup: Command): void {
  const sqlite = backup
    .command("sqlite")
    .description("Create, list, verify, and restore SQLite snapshots")
    .action(() => {
      sqlite.outputHelp();
      process.exitCode = 1;
    });

  sqlite
    .command("create")
    .description("Create a compact, verified snapshot of an OpenClaw SQLite database")
    .option("--global", "Snapshot the shared OpenClaw state database", false)
    .option("--agent <id>", "Snapshot one per-agent OpenClaw database")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw backup sqlite create --global --repository ~/Backups/openclaw-sqlite",
            "Snapshot the shared state database.",
          ],
          [
            "openclaw backup sqlite create --agent main --repository ~/Backups/openclaw-sqlite",
            "Snapshot the main agent database.",
          ],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupSqliteCreateCommand(defaultRuntime, {
          global: Boolean(opts.global),
          agent: opts.agent as string | undefined,
          repository: opts.repository as string,
          json: Boolean(opts.json),
        });
      });
    });

  sqlite
    .command("list")
    .description("List committed snapshots in a repository")
    .requiredOption("--repository <path>", "Snapshot repository directory")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupSqliteListCommand(defaultRuntime, {
          repository: opts.repository as string,
          json: Boolean(opts.json),
        });
      });
    });

  sqlite
    .command("verify <snapshot>")
    .description("Verify a snapshot manifest, artifact hash, SQLite integrity, and database owner")
    .option("--scratch <path>", "Existing private directory for verification copies")
    .option("--json", "Output JSON", false)
    .action(async (snapshot, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupSqliteVerifyCommand(defaultRuntime, snapshot as string, {
          scratch: opts.scratch as string | undefined,
          json: Boolean(opts.json),
        });
      });
    });

  sqlite
    .command("restore <snapshot>")
    .description("Restore a verified snapshot to a new SQLite database path")
    .requiredOption("--target <path>", "Fresh target path; existing files and sidecars are refused")
    .option("--json", "Output JSON", false)
    .action(async (snapshot, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await backupSqliteRestoreCommand(defaultRuntime, snapshot as string, {
          target: opts.target as string,
          json: Boolean(opts.json),
        });
      });
    });
}
