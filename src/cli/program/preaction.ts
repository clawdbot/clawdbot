import type { Command } from "commander";
import {
  isNixMode,
  loadConfig,
  migrateLegacyConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import { danger } from "../../globals.js";
import { autoMigrateLegacyState } from "../../infra/state-migrations.js";
import { defaultRuntime } from "../../runtime.js";
import { emitCliBanner } from "../banner.js";

export function registerPreActionHooks(
  program: Command,
  programVersion: string,
) {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    emitCliBanner(programVersion);
    if (actionCommand.name() === "doctor") return;
    const snapshot = await readConfigFileSnapshot();
    if (snapshot.legacyIssues.length === 0) return;
    if (isNixMode) {
      defaultRuntime.error(
        danger(
          "Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and retry.",
        ),
      );
      process.exit(1);
    }
    const migrated = migrateLegacyConfig(snapshot.parsed);
    if (migrated.config) {
      await writeConfigFile(migrated.config);
      if (migrated.changes.length > 0) {
        defaultRuntime.log(
          `Migrated legacy config entries:\n${migrated.changes
            .map((entry) => `- ${entry}`)
            .join("\n")}`,
        );
      }
      return;
    }
    const issues = snapshot.legacyIssues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join("\n");
    defaultRuntime.error(
      danger(
        `Legacy config entries detected. Run "clawdbot doctor" (or ask your agent) to migrate.\n${issues}`,
      ),
    );
    process.exit(1);
  });

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    if (actionCommand.name() === "doctor") return;
    const cfg = loadConfig();
    await autoMigrateLegacyState({ cfg });
  });
}
