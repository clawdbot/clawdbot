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

/**
 * `models` subcommands that only ever read or write global model config.
 * The value describes the scope so the rejection message stays accurate per command.
 */
const GLOBAL_ONLY_MODEL_COMMAND_SCOPE = {
  set: "updates global model defaults",
  "set-image": "updates global model defaults",
  scan: "updates global model defaults",
  "aliases list": "reads global model aliases",
  "aliases add": "updates global model aliases",
  "aliases remove": "updates global model aliases",
} as const;

export type GlobalOnlyModelCommandName = keyof typeof GLOBAL_ONLY_MODEL_COMMAND_SCOPE;

export function rejectAgentScopedModelCommand(
  command: Command,
  commandName: GlobalOnlyModelCommandName,
): void {
  // These commands only touch global defaults; accepting --agent here would imply per-agent scope.
  const agent = resolveOptionFromCommand<string>(command, "agent");
  if (!agent) {
    return;
  }
  throw new Error(
    `openclaw models ${commandName} does not support --agent; it only ${GLOBAL_ONLY_MODEL_COMMAND_SCOPE[commandName]}. Remove --agent, or run ${formatCliCommand("openclaw agents list")} and set the per-agent model in agent config.`,
  );
}
