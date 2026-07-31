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

export function rejectAgentScopedModelWrite(
  command: Command,
  commandName: "set" | "set-image",
): void {
  // Write commands update global defaults; accepting --agent here would imply per-agent mutation.
  const agent = resolveOptionFromCommand<string>(command, "agent");
  if (!agent) {
    return;
  }
  throw new Error(
    `openclaw models ${commandName} does not support --agent; it only updates global model defaults. Remove --agent, or run ${formatCliCommand("openclaw agents list")} and set the per-agent model in agent config.`,
  );
}

export function rejectAgentScopedImageFallbacks(command: Command): void {
  // Image model fallbacks live only on agents.defaults.imageModel; accepting
  // --agent here would imply per-agent scoping that does not exist.
  const agent = resolveOptionFromCommand<string>(command, "agent");
  if (!agent) {
    return;
  }
  throw new Error(
    `openclaw models image-fallbacks does not support --agent; image model fallbacks are configured on global defaults only. Remove --agent, or run ${formatCliCommand("openclaw models status --agent <id>")} to inspect an agent's effective models.`,
  );
}
