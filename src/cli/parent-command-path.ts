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

type ParentCommandFlags = readonly [booleanFlags: readonly string[], valueFlags: readonly string[]];

const PARENT_COMMAND_FLAGS: ReadonlyMap<string, ParentCommandFlags> = new Map([
  ["agent", [AGENT_PARENT_BOOLEAN_FLAGS, AGENT_PARENT_VALUE_FLAGS]],
  ["models", [MODELS_PARENT_BOOLEAN_FLAGS, MODELS_PARENT_VALUE_FLAGS]],
  ["config", [[], ["--section"]]],
  ["skills", [["--json"], ["--agent"]]],
  ["channels", [[], ["--agent"]]],
  ["update", [UPDATE_PARENT_BOOLEAN_FLAGS, UPDATE_PARENT_VALUE_FLAGS]],
]);

/** Resolve the parent commands whose options may precede a child command. */
export function resolveCliParentCommandPath(
  argv: readonly string[],
  expectedParent?: "models" | "config" | "skills",
): string[] | null {
  const [command] = getRootOptionAwareCommandPath(argv, 1);
  if (!command || (expectedParent && command !== expectedParent)) {
    return null;
  }
  const flags = PARENT_COMMAND_FLAGS.get(command);
  if (!flags) {
    return null;
  }
  const [booleanFlags, valueFlags] = flags;
  const child = getCommandPositionalsWithRootOptions(argv, {
    commandPath: [command],
    booleanFlags,
    valueFlags,
    maxPositionals: 1,
    mode: "command-path",
  })?.[0];
  return child ? [command, child] : [command];
}
