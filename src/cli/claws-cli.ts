// Commander registration for experimental Claws inspection and add previews.
import type { Command } from "commander";
import { isExperimentalClawsEnabled } from "../claws/experimental.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export type ClawsInspectOptions = {
  json?: boolean;
};

export type ClawsAddOptions = {
  dryRun?: boolean;
  yes?: boolean;
  planIntegrity?: string;
  json?: boolean;
  agentId?: string;
  workspace?: string;
};

export type ClawsStatusOptions = { json?: boolean };
export type ClawsUpdateOptions = {
  from?: string;
  dryRun?: boolean;
  yes?: boolean;
  planIntegrity?: string;
  json?: boolean;
};
export type ClawsRemoveOptions = {
  dryRun?: boolean;
  yes?: boolean;
  planIntegrity?: string;
  removeUnused?: boolean;
  removeReferenced?: string[];
  forceReferenced?: boolean;
  json?: boolean;
};
export type ClawsExportOptions = { out: string; json?: boolean };

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerClawsCli(program: Command) {
  if (!isExperimentalClawsEnabled()) {
    return;
  }
  const claws = program.command("claws").description("Manage experimental OpenClaw Claws");

  claws
    .command("inspect")
    .description("Validate a Claw package or local development manifest")
    .argument("<source>", "Path to a Claw package directory or grouped manifest")
    .option("--json", "Print JSON", false)
    .action(async (source: string, opts: ClawsInspectOptions) => {
      const { runClawsInspectCommand } = await import("./claws-cli.runtime.js");
      await runClawsInspectCommand(source, opts);
    });

  claws
    .command("add")
    .description("Preview adding one new agent and workspace from a Claw")
    .argument("<source>", "Path to a Claw package directory or grouped manifest")
    .option("--dry-run", "Preview all actions without mutating state", false)
    .option("--yes", "Confirm creation of the new agent and workspace", false)
    .option("--plan-integrity <digest>", "Bind consent to an exact dry-run plan")
    .option("--agent-id <id>", "Override the requested id with an unused local agent id")
    .option("--workspace <path>", "Override the derived new workspace path")
    .option("--json", "Print JSON", false)
    .action(async (source: string, opts: ClawsAddOptions) => {
      const { runClawsAddCommand } = await import("./claws-cli.runtime.js");
      await runClawsAddCommand(source, opts);
    });

  claws
    .command("status")
    .description("Show installed Claw agents and managed-state drift")
    .argument("[claw-or-agent]", "Installed package name or final agent id")
    .option("--json", "Print JSON", false)
    .action(async (target: string | undefined, opts: ClawsStatusOptions) => {
      const { runClawsStatusCommand } = await import("./claws-cli.runtime.js");
      await runClawsStatusCommand(target, opts);
    });

  claws
    .command("update")
    .description("Plan changes to one installed Claw agent")
    .argument("<claw-or-agent>", "Installed package name or final agent id")
    .option("--from <source>", "Override the target source recorded at Claw add time")
    .option("--dry-run", "Preview update actions without mutating state", false)
    .option("--yes", "Confirm the exact supported update plan", false)
    .option("--plan-integrity <digest>", "Bind consent to an exact update plan")
    .option("--json", "Print JSON", false)
    .action(async (target: string, opts: ClawsUpdateOptions) => {
      const { runClawsUpdateCommand } = await import("./claws-cli.runtime.js");
      await runClawsUpdateCommand(target, opts);
    });

  claws
    .command("remove")
    .description("Plan or remove one Claw-created agent and owned state")
    .argument("<claw-or-agent>", "Installed package name or final agent id")
    .option("--dry-run", "Preview removal without mutating state", false)
    .option("--yes", "Confirm removal", false)
    .option("--plan-integrity <digest>", "Bind consent to an exact removal plan")
    .option(
      "--remove-unused",
      "Remove unchanged Claw-introduced references with no other current owner",
      false,
    )
    .option(
      "--remove-referenced <resource>",
      "Remove an exact referenced resource (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--force-referenced",
      "Allow selected cleanup despite other dependents, owners, or pre-existing origin",
      false,
    )
    .option("--json", "Print JSON", false)
    .action(async (target: string, opts: ClawsRemoveOptions) => {
      const { runClawsRemoveCommand } = await import("./claws-cli.runtime.js");
      await runClawsRemoveCommand(target, opts);
    });

  claws
    .command("export")
    .description("Export portable state for one installed Claw agent")
    .argument("<agent>", "Final id of the installed Claw agent")
    .requiredOption("--out <path>", "New package directory to create")
    .option("--json", "Print JSON", false)
    .action(async (agent: string, opts: ClawsExportOptions) => {
      const { runClawsExportCommand } = await import("./claws-cli.runtime.js");
      await runClawsExportCommand(agent, opts);
    });

  applyParentDefaultHelpAction(claws);
}
