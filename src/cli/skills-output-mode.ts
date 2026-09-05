import type { Command } from "commander";
import { hasMachineOutputOption } from "./machine-output-argv.js";
import { resolveSkillsParentCommandPath } from "./parent-command-path.js";

/** Skill verification emits JSON unless the caller explicitly requests the Markdown card. */
export function isSkillsMachineOutput(argv: readonly string[], command?: Command): boolean {
  return (
    resolveSkillsParentCommandPath(argv)?.[1] === "verify" &&
    !hasMachineOutputOption(argv, "--card", command)
  );
}
