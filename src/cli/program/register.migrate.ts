import type { Command } from "commander";
import {
  migrateApplyCommand,
  migrateDefaultCommand,
  migrateListCommand,
  migratePlanCommand,
} from "../../commands/migrate.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

function collectMigrationSkill(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function collectMigrationPlugin(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function readMigrationSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const skills = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return skills.length > 0 ? skills : undefined;
}

function readMigrationPlugins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const plugins = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return plugins.length > 0 ? plugins : undefined;
}

function addMigrationSkillOption(command: Command): Command {
  return command.option(
    "--skill <name>",
    "Select one skill to migrate by name or item id; repeat for multiple skills",
    collectMigrationSkill,
  );
}

function addMigrationPluginOption(command: Command): Command {
  return command.option(
    "--plugin <name>",
    "Select one Codex plugin to migrate by name or item id; repeat for multiple plugins",
    collectMigrationPlugin,
  );
}

function addMigrationOptions(command: Command): Command {
  return addMigrationPluginOption(
    addMigrationSkillOption(
      command
        .option("--from <path>", "Source directory to migrate from")
        .option("--include-secrets", "Import supported credentials and secrets", false)
        .option("--overwrite", "Overwrite conflicting target files after item-level backups", false)
        .option("--json", "Output JSON", false),
    ),
  );
}

export function registerMigrateCommand(program: Command) {
  const migrate = program
    .command("migrate")
    .description("Import state from another agent system")
    .argument("[provider]", "Migration provider id, for example hermes")
    .option("--from <path>", "Source directory to migrate from")
    .option("--include-secrets", "Import supported credentials and secrets", false)
    .option("--overwrite", "Overwrite conflicting target files after item-level backups", false)
    .option("--dry-run", "Preview only; do not apply changes", false)
    .option("--yes", "Apply without prompting after preview", false)
    .option(
      "--skill <name>",
      "Select one skill to migrate by name or item id; repeat for multiple skills",
      collectMigrationSkill,
    )
    .option(
      "--plugin <name>",
      "Select one Codex plugin to migrate by name or item id; repeat for multiple plugins",
      collectMigrationPlugin,
    )
    .option("--backup-output <path>", "Pre-migration backup archive path or directory")
    .option("--no-backup", "Skip the pre-migration OpenClaw backup")
    .option("--force", "Allow dangerous options such as --no-backup", false)
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw migrate list", "Show available migration providers."],
          ["openclaw migrate hermes", "Preview Hermes migration, then prompt before applying."],
          ["openclaw migrate hermes --dry-run", "Preview Hermes migration only."],
          [
            "openclaw migrate apply hermes --yes",
            "Apply Hermes migration non-interactively after writing a verified backup.",
          ],
          [
            "openclaw migrate apply hermes --include-secrets --yes",
            "Include supported credentials in the migration.",
          ],
        ])}`,
    )
    .action(async (provider, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await migrateDefaultCommand(defaultRuntime, {
          provider: provider as string | undefined,
          source: opts.from as string | undefined,
          includeSecrets: Boolean(opts.includeSecrets),
          overwrite: Boolean(opts.overwrite),
          skills: readMigrationSkills(opts.skill),
          plugins: readMigrationPlugins(opts.plugin),
          dryRun: Boolean(opts.dryRun),
          yes: Boolean(opts.yes),
          backupOutput: opts.backupOutput as string | undefined,
          noBackup: opts.backup === false,
          force: Boolean(opts.force),
          json: Boolean(opts.json),
        });
      });
    });

  migrate
    .command("list")
    .description("List migration providers")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await migrateListCommand(defaultRuntime, { json: Boolean(opts.json) });
      });
    });

  addMigrationOptions(
    migrate
      .command("plan <provider>")
      .description("Preview a migration without changing OpenClaw state"),
  ).action(async (provider, opts) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await migratePlanCommand(defaultRuntime, {
        provider: provider as string,
        source: opts.from as string | undefined,
        includeSecrets: Boolean(opts.includeSecrets),
        overwrite: Boolean(opts.overwrite),
        skills: readMigrationSkills(opts.skill),
        plugins: readMigrationPlugins(opts.plugin),
        json: Boolean(opts.json),
      });
    });
  });

  addMigrationOptions(
    migrate.command("apply <provider>").description("Apply a migration after a verified backup"),
  )
    .option("--yes", "Apply without prompting", false)
    .option("--backup-output <path>", "Pre-migration backup archive path or directory")
    .option("--no-backup", "Skip the pre-migration OpenClaw backup")
    .option("--force", "Allow dangerous options such as --no-backup", false)
    .action(async (provider, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await migrateApplyCommand(defaultRuntime, {
          provider: provider as string,
          source: opts.from as string | undefined,
          includeSecrets: Boolean(opts.includeSecrets),
          overwrite: Boolean(opts.overwrite),
          skills: readMigrationSkills(opts.skill),
          plugins: readMigrationPlugins(opts.plugin),
          yes: Boolean(opts.yes),
          backupOutput: opts.backupOutput as string | undefined,
          noBackup: opts.backup === false,
          force: Boolean(opts.force),
          json: Boolean(opts.json),
        });
      });
    });
}
