import { consumeRootOptionToken } from "../infra/cli-root-options.js";
import {
  findMachineOutputRootCommandIndex,
  hasMachineOutputOption,
} from "./machine-output-argv.js";

function resolveSkillsSubcommand(argv: readonly string[]): string | null {
  const rootIndex = findMachineOutputRootCommandIndex(argv);
  if (rootIndex === null) {
    return null;
  }
  for (let index = rootIndex + 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || arg === "--") {
      return null;
    }
    const rootConsumed = consumeRootOptionToken(argv.slice(2), index - 2);
    if (rootConsumed > 0) {
      index += rootConsumed - 1;
      continue;
    }
    if (arg === "--agent") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return null;
}

/** Skill verification emits JSON unless the caller explicitly requests the Markdown card. */
export function isSkillsMachineOutput(argv: readonly string[]): boolean {
  return resolveSkillsSubcommand(argv) === "verify" && !hasMachineOutputOption(argv, "--card");
}
