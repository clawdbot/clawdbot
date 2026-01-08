import type { Command } from "commander";

export function hasExplicitOptions(
  command: Command,
  names: readonly string[],
): boolean {
  if (typeof command.getOptionValueSource !== "function") {
    return false;
  }
  return names.some((name) => command.getOptionValueSource(name) === "cli");
}
