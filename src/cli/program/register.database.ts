import type { Command } from "commander";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime, writeRuntimeJson, writeRuntimeStdout } from "../../runtime.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  preflightOpenClawStateDatabasePath,
} from "../../state/openclaw-database-preflight.js";
import { resolveDatabasePath } from "../../state/openclaw-state-db-maintenance.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { inspectOpenClawStateOwnershipAtPath } from "../../state/openclaw-state-ownership.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

type DatabaseOutputOptions = { json?: boolean };

function writeDatabaseError(error: unknown, json: boolean): void {
  const message = formatErrorMessage(error);
  if (json) {
    writeRuntimeJson(defaultRuntime, { error: message });
  } else {
    defaultRuntime.error(message);
  }
  defaultRuntime.exit(1);
}

async function runDatabasePreflight(databasePath: string, options: DatabaseOutputOptions) {
  const result = await preflightOpenClawStateDatabasePath(databasePath);
  if (options.json) {
    writeRuntimeJson(defaultRuntime, result);
  } else {
    const detail = result.reason ?? result.issues[0]?.message;
    writeRuntimeStdout(
      defaultRuntime,
      `Database preflight: ${result.status} (found ${result.foundVersion ?? "unknown"}, target ${result.targetVersion}).${detail ? `\n${detail}` : ""}\nSee ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.\n`,
    );
  }
  if (result.status === "incompatible" || result.status === "indeterminate") {
    defaultRuntime.exit(1);
  }
}

function runDatabaseOwnership(options: DatabaseOutputOptions & { manager?: string }): void {
  try {
    const databasePath = resolveDatabasePath({ env: process.env });
    const ownership =
      options.manager !== undefined
        ? claimOpenClawStateOwnership(options.manager, {
            path: databasePath,
            env: process.env,
          })
        : inspectOpenClawStateOwnershipAtPath(databasePath);
    const status = ownership
      ? { status: "external" as const, ownership }
      : { status: "unowned" as const };
    if (options.json) {
      writeRuntimeJson(defaultRuntime, { databasePath, ...status });
      return;
    }
    const message =
      status.status === "external"
        ? `Shared state is externally owned by ${status.ownership.managerId}.`
        : "Shared state is not externally owned.";
    writeRuntimeStdout(defaultRuntime, `${message}\nSee ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.\n`);
  } catch (error) {
    writeDatabaseError(error, options.json === true);
  }
}

export function registerDatabaseCommand(program: Command): void {
  const database = program
    .command("database")
    .description("Inspect shared-state schema compatibility and write ownership")
    .addHelpText("after", `\nDocs: ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}\n`);

  database
    .command("preflight")
    .description("Compare one copied SQLite file with this release's state schema")
    .argument("<path>", "explicit copied SQLite database path")
    .option("--json", "emit machine-readable JSON", false)
    .action(async (databasePath: string, options: DatabaseOutputOptions) => {
      await runDatabasePreflight(databasePath, options);
    });

  const ownership = database.command("ownership").description("Inspect or claim write ownership");
  ownership
    .command("status")
    .description("Show durable shared-state write ownership")
    .option("--json", "emit machine-readable JSON", false)
    .action((options: DatabaseOutputOptions) => runDatabaseOwnership(options));
  ownership
    .command("claim")
    .description("Claim shared-state writes for the active external supervisor")
    .requiredOption("--manager <id>", "stable external manager identifier")
    .option("--json", "emit machine-readable JSON", false)
    .action((options: DatabaseOutputOptions & { manager: string }) =>
      runDatabaseOwnership(options),
    );
  applyParentDefaultHelpAction(ownership);
  applyParentDefaultHelpAction(database);
}
