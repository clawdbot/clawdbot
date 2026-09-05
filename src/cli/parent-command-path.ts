import {
  getCommandPositionalsWithRootOptions,
  getRootOptionAwareCommandPath,
} from "../infra/cli-root-options.js";
import { UPDATE_OPTION_SPECS } from "./update-option-specs.js";

const AGENT_PARENT_BOOLEAN_FLAGS = ["--local", "--deliver", "--json"];
const AGENT_PARENT_VALUE_FLAGS = [
  "-m",
  "--message",
  "--message-file",
  "-t",
  "--to",
  "--session-key",
  "--session-id",
  "--agent",
  "--model",
  "--thinking",
  "--verbose",
  "--channel",
  "--reply-to",
  "--reply-channel",
  "--reply-account",
  "--timeout",
];
export const MODELS_PARENT_BOOLEAN_FLAGS = ["--json", "--status-json", "--status-plain"];
export const MODELS_PARENT_VALUE_FLAGS = ["--agent"];
const UPDATE_PARENT_BOOLEAN_FLAGS = UPDATE_OPTION_SPECS.filter(
  ([flags]) => !flags.includes("<"),
).map(([flags]) => flags);
const UPDATE_PARENT_VALUE_FLAGS = UPDATE_OPTION_SPECS.filter(([flags]) => flags.includes("<")).map(
  ([flags]) => flags.slice(0, flags.indexOf(" ")),
);

function resolveParentCommandPath(
  argv: readonly string[],
  command: string,
  booleanFlags: readonly string[],
  valueFlags: readonly string[],
): string[] | null {
  if (getRootOptionAwareCommandPath(argv, 1)[0] !== command) {
    return null;
  }
  const child = getCommandPositionalsWithRootOptions(argv, {
    commandPath: [command],
    booleanFlags,
    valueFlags,
    maxPositionals: 1,
    mode: "command-path",
  })?.[0];
  return child ? [command, child] : [command];
}

export function resolveModelsParentCommandPath(argv: readonly string[]): string[] | null {
  return resolveParentCommandPath(
    argv,
    "models",
    MODELS_PARENT_BOOLEAN_FLAGS,
    MODELS_PARENT_VALUE_FLAGS,
  );
}

export function resolveConfigParentCommandPath(argv: readonly string[]): string[] | null {
  return resolveParentCommandPath(argv, "config", [], ["--section"]);
}

export function resolveSkillsParentCommandPath(argv: readonly string[]): string[] | null {
  return resolveParentCommandPath(argv, "skills", ["--json"], ["--agent"]);
}

/** Resolve the parent commands whose options may precede a child command. */
export function resolveParentAwareCommandPath(argv: readonly string[]): string[] | null {
  return (
    resolveParentCommandPath(argv, "agent", AGENT_PARENT_BOOLEAN_FLAGS, AGENT_PARENT_VALUE_FLAGS) ??
    resolveModelsParentCommandPath(argv) ??
    resolveConfigParentCommandPath(argv) ??
    resolveSkillsParentCommandPath(argv) ??
    resolveParentCommandPath(argv, "channels", [], ["--agent"]) ??
    resolveParentCommandPath(argv, "update", UPDATE_PARENT_BOOLEAN_FLAGS, UPDATE_PARENT_VALUE_FLAGS)
  );
}
