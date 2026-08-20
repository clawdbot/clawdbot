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

/** Subcommands of `models` that only ever touch `agents.defaults`, never one agent. */
export type GlobalOnlyModelsCommand =
  | "set"
  | "set-image"
  | "aliases list"
  | "aliases add"
  | "aliases remove"
  | "scan";

export function rejectAgentScopedModelCommand(
  command: Command,
  commandName: GlobalOnlyModelsCommand,
): void {
  // These read and write `agents.defaults` only; accepting --agent here would imply
  // per-agent scoping that no downstream code path provides.
  const agent = resolveOptionFromCommand<string>(command, "agent");
  if (!agent) {
    return;
  }
  throw new Error(
    `openclaw models ${commandName} does not support --agent; it only affects the global model defaults under agents.defaults. Remove --agent, or run ${formatCliCommand("openclaw agents list")} and set the per-agent model in agent config.`,
  );
}
