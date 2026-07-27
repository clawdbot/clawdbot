// JSON-mode metadata for Commander commands; distinguishes JSON output from parse-only flags.
import type { Command } from "commander";
import { hasFlag } from "../argv.js";
import {
  isMachineOutputStdoutTTY,
  type MachineOutputResolverParams,
} from "../machine-output-argv.js";

const jsonModeSymbol = Symbol("openclaw.cli.jsonMode");

type CommandJsonMode = "output" | "parse-only";
type CommandJsonModeResolver = (
  params: {
    command: Command;
  } & MachineOutputResolverParams,
) => boolean;

type CommandJsonModeDeclaration = {
  mode: CommandJsonMode;
  resolve?: CommandJsonModeResolver;
};
type JsonModeCommand = Command & {
  [jsonModeSymbol]?: CommandJsonModeDeclaration;
};

function commandDefinesJsonOption(command: Command): boolean {
  return command.options.some((option) => option.long === "--json");
}

function getCommandJsonMode(
  command: Command,
  argv: string[] = process.argv,
): CommandJsonMode | null {
  const literalJsonMode =
    command.optsWithGlobals<{ json?: unknown }>().json === true || hasFlag(argv, "--json");
  for (let current: Command | null = command; current; current = current.parent ?? null) {
    const metadata = (current as JsonModeCommand)[jsonModeSymbol];
    if (metadata?.resolve?.({ command, argv, stdoutIsTTY: isMachineOutputStdoutTTY() })) {
      return metadata.mode;
    }
    if (metadata && !metadata.resolve && literalJsonMode) {
      return metadata.mode;
    }
    if (literalJsonMode && commandDefinesJsonOption(current)) {
      return "output";
    }
  }
  return null;
}

/** Mark a command as having a special JSON mode beyond ordinary `--json` output. */
export function setCommandJsonMode(
  command: Command,
  mode: CommandJsonMode,
  resolve?: CommandJsonModeResolver,
): Command {
  (command as JsonModeCommand)[jsonModeSymbol] = { mode, ...(resolve ? { resolve } : {}) };
  return command;
}

/** Return true when the command's active mode owns machine-readable JSON stdout. */
export function isCommandJsonOutputMode(command: Command, argv: string[] = process.argv): boolean {
  return getCommandJsonMode(command, argv) === "output";
}
