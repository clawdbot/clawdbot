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

export function rejectAgentScopedModelCommand(
  command: Command,
  commandName: string,
  scope = "only updates global model defaults",
): void {
  // Global-only model subcommands (set/set-image writes, aliases list/add/remove,
  // scan) have no per-agent code path; accepting --agent would imply agent scoping
  // that does not exist. Reject the flag outright instead of silently accepting a
  // no-op (an unvalidated/invalid agent id otherwise passes through unchecked).
  const agent = resolveOptionFromCommand<string>(command, "agent");
  // Blank ("") is present-but-empty, not absence: resolveOptionFromCommand returns
  // undefined only for an unset option, while an explicit `--agent ""` resolves to
  // "". Reject it like a populated value so the empty string cannot bypass the guard
  // and reach a global handler — mirrors resolveModelsTargetAgent's
  // undefined-vs-blank check (src/commands/models/shared.ts).
  if (agent === undefined) {
    return;
  }
  throw new Error(
    `openclaw models ${commandName} does not support --agent; it ${scope}. Remove --agent, or run ${formatCliCommand("openclaw agents list")} and set the per-agent model in agent config.`,
  );
}
