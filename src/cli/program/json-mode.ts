import type { Command } from "commander";
import { hasFlag } from "../argv.js";

const jsonModeSymbol = Symbol("openclaw.cli.jsonMode");

type JsonMode = "output" | "parse-only";
type JsonModeCommand = Command & {
  [jsonModeSymbol]?: JsonMode;
};

function commandDefinesJsonOption(command: Command): boolean {
  return command.options.some((option) => option.long === "--json");
}

function getDeclaredCommandJsonMode(command: Command): JsonMode | null {
  for (let current: Command | null = command; current; current = current.parent ?? null) {
    const metadata = (current as JsonModeCommand)[jsonModeSymbol];
    if (metadata) {
      return metadata;
    }
    if (commandDefinesJsonOption(current)) {
      return "output";
    }
  }
  return null;
}

function commandSelectedJsonFlag(command: Command, argv: string[]): boolean {
  const commandWithGlobals = command as Command & {
    optsWithGlobals?: () => Record<string, unknown>;
  };
  if (typeof commandWithGlobals.optsWithGlobals === "function") {
    const resolved = commandWithGlobals.optsWithGlobals().json;
    if (resolved === true) {
      return true;
    }
  }
  return hasFlag(argv, "--json");
}

export function setCommandJsonMode(command: Command, mode: JsonMode): Command {
  (command as JsonModeCommand)[jsonModeSymbol] = mode;
  return command;
}

function getCommandJsonMode(command: Command, argv: string[] = process.argv): JsonMode | null {
  if (!commandSelectedJsonFlag(command, argv)) {
    return null;
  }
  return getDeclaredCommandJsonMode(command);
}

export function isCommandJsonOutputMode(command: Command, argv: string[] = process.argv): boolean {
  return getCommandJsonMode(command, argv) === "output";
}
