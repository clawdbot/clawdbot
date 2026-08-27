// Runtime helpers for model CLI commands and shared agent option handling.
import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { resolveOptionFromCommand, runCommandWithRuntime } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";

export { defaultRuntime };

export function runModelsCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action);
}

export function resolveModelAgentOption(
  command: Command | undefined,
  opts?: { agent?: unknown },
): string | undefined {
  return (
    resolveOptionFromCommand<string>(command, "agent") ??
    (typeof opts?.agent === "string" ? opts.agent : undefined)
  );
}

/** `models` subcommands that operate on global state only, never per-agent. */
export type GlobalOnlyModelCommandName =
  | "set"
  | "set-image"
  | "scan"
  | "aliases list"
  | "aliases add"
  | "aliases remove"
  | "refresh";

export function rejectAgentScopedModelCommand(
  command: Command,
  commandName: GlobalOnlyModelCommandName,
): void {
  // None of these resolve an agent, so accepting --agent would imply a scope that
  // does not exist. Kept scope-neutral: `scan --no-probe` returns after printing
  // the catalog without writing config at all.
  const agent = resolveOptionFromCommand<string>(command, "agent");
  if (!agent) {
    return;
  }
  throw new Error(
    `openclaw models ${commandName} does not support --agent; it is global and never agent-scoped. Remove --agent, or run ${formatCliCommand("openclaw agents list")} and set the per-agent model in agent config.`,
  );
}
