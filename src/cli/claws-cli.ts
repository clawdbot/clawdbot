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

export function registerClawsCli(program: Command) {
  if (!isExperimentalClawsEnabled()) {
    return;
  }
  const claws = program.command("claws").description("Inspect and add experimental OpenClaw Claws");

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

  applyParentDefaultHelpAction(claws);
}
