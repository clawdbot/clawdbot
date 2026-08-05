// Migration command registration: list, plan, and apply migration providers.
import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  migrateApplyCommand,
  migrateDefaultCommand,
  migrateListCommand,
  migratePlanCommand,
} from "../../commands/migrate.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

function collectMigrationSkill(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function collectMigrationPlugin(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function collectMigrationItem(value: string, previous: string[] | undefined): string[] {
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

function readMigrationItems(value: unknown, command?: Command): string[] | undefined {
  const selected = Array.isArray(value) ? value : command?.parent?.opts().item;
  if (!Array.isArray(selected)) {
    return undefined;
  }
  const items = selected
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
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

function addVerifyPluginAppsOption(command: Command): Command {
  return command.option(
    "--verify-plugin-apps",
    "Codex only: verify source plugin app accessibility with app/installed before planning native plugin activation",
    false,
  );
}

function addMigrationItemOption(command: Command): Command {
  return command.option(
    "--item <id>",
    "Select one exact migration item id; repeat for multiple items",
    collectMigrationItem,
  );
}

function addMigrationOptions(command: Command): Command {
  return addVerifyPluginAppsOption(
    addMigrationItemOption(
      addMigrationPluginOption(
        addMigrationSkillOption(
          command
            .option("--from <path>", "Source directory to migrate from")
            .option("--agent <id>", "Target agent (default: configured default agent)")
            .option("--include-secrets", "Import supported credentials and secrets")
            .option("--no-auth-credentials", "Skip auth credential migration")
            .option(
              "--overwrite",
              "Overwrite conflicting target files after item-level backups",
              false,
            )
            .option("--json", "Output JSON", false),
        ),
      ),
    ),
  );
}

function readVerifyPluginApps(value: unknown): boolean {
  return value === true;
}

function readMigrationTargetAgentId(value: unknown, command: Command): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const parentValue = command.parent?.opts().agent;
  return typeof parentValue === "string" ? parentValue : undefined;
}

/** Register migration commands and shared provider/item selection flags. */
export function registerMigrateCommand(program: Command) {
  const migrate = addVerifyPluginAppsOption(
    program
      .command("migrate")
      .description("Import state from another agent system")
      .argument("[provider]", "Migration provider id, for example hermes")
      .option("--from <path>", "Source directory to migrate from")
      .option("--agent <id>", "Target agent (default: configured default agent)")
      .option("--include-secrets", "Import supported credentials and secrets")
      .option("--no-auth-credentials", "Skip auth credential migration")
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
      .option(
        "--item <id>",
        "Select one exact migration item id; repeat for multiple items",
        collectMigrationItem,
      )
      .option("--backup-output <path>", "Pre-migration backup archive path or directory")
      .option("--no-backup", "Skip the pre-migration OpenClaw backup")
      .option("--force", "Allow dangerous options such as --no-backup", false)
      .option("--json", "Output JSON", false),
  )
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
            "openclaw migrate hermes --no-auth-credentials",
            "Preview and apply Hermes migration while skipping auth credential import.",
          ],
        ])}`,
    )
    .action(async (provider, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await migrateDefaultCommand(defaultRuntime, {
          provider: provider as string | undefined,
          source: opts.from as string | undefined,
          targetAgentId: opts.agent as string | undefined,
          includeSecrets: opts.includeSecrets === true ? true : undefined,
          authCredentials: opts.authCredentials as boolean | undefined,
          overwrite: Boolean(opts.overwrite),
          skills: readMigrationSkills(opts.skill),
          plugins: readMigrationPlugins(opts.plugin),
          itemIds: readMigrationItems(opts.item),
          verifyPluginApps: readVerifyPluginApps(opts.verifyPluginApps),
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
  ).action(async (provider, opts, command) => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      await migratePlanCommand(defaultRuntime, {
        provider: provider as string,
        source: opts.from as string | undefined,
        targetAgentId: readMigrationTargetAgentId(opts.agent, command),
        includeSecrets: opts.includeSecrets === true ? true : undefined,
        authCredentials: opts.authCredentials as boolean | undefined,
        overwrite: Boolean(opts.overwrite),
        skills: readMigrationSkills(opts.skill),
        plugins: readMigrationPlugins(opts.plugin),
        itemIds: readMigrationItems(opts.item, command),
        verifyPluginApps: readVerifyPluginApps(opts.verifyPluginApps),
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
    .action(async (provider, opts, command) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await migrateApplyCommand(defaultRuntime, {
          provider: provider as string,
          source: opts.from as string | undefined,
          targetAgentId: readMigrationTargetAgentId(opts.agent, command),
          includeSecrets: opts.includeSecrets === true ? true : undefined,
          authCredentials: opts.authCredentials as boolean | undefined,
          overwrite: Boolean(opts.overwrite),
          skills: readMigrationSkills(opts.skill),
          plugins: readMigrationPlugins(opts.plugin),
          itemIds: readMigrationItems(opts.item, command),
          verifyPluginApps: readVerifyPluginApps(opts.verifyPluginApps),
          yes: Boolean(opts.yes),
          backupOutput: opts.backupOutput as string | undefined,
          noBackup: opts.backup === false,
          force: Boolean(opts.force),
          json: Boolean(opts.json),
        });
      });
    });
}
