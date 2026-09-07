import { levenshteinDistance } from "../../shared/levenshtein-distance.js";
import { formatCliCommand } from "../command-format.js";
import { getCoreCliCommandNamesCore } from "./core-command-descriptors.js";
import { getSubCliEntriesCore } from "./subcli-descriptors.js";

const EXPLICIT_COMMAND_ALIASES = new Map<string, string>([
  ["upgrade", "update"],
  ["udpate", "update"],
]);

const MAX_SUGGESTIONS = 3;

function uniqueSortedCommandNames(commands: Iterable<string>): string[] {
  return [...new Set([...commands].filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function formatCliCommandSuggestions(
  input: string,
  commandPath: readonly string[] = [],
  candidates?: Iterable<string>,
): string | undefined {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput) {
    return undefined;
  }

  const knownCommands = uniqueSortedCommandNames(
    candidates ??
      (commandPath.length === 0
        ? [...getCoreCliCommandNamesCore(), ...getSubCliEntriesCore().map((entry) => entry.name)]
        : []),
  );
  const explicitAlias = EXPLICIT_COMMAND_ALIASES.get(normalizedInput);
  if (explicitAlias && knownCommands.includes(explicitAlias)) {
    return formatCliSuggestionLines([explicitAlias], commandPath);
  }
  const suggestions = findCliCommandSuggestions(normalizedInput, knownCommands);
  if (suggestions.length === 0) {
    return undefined;
  }
  return formatCliSuggestionLines(suggestions, commandPath);
}

function findCliCommandSuggestions(input: string, candidates: readonly string[]): string[] {
  const maxDistance = Math.max(1, Math.floor(input.length * 0.4));
  return candidates
    .map((command) => ({ command, distance: levenshteinDistance(input, command) }))
    .filter(({ command, distance }) => command !== input && distance <= maxDistance)
    .toSorted(
      (left, right) => left.distance - right.distance || left.command.localeCompare(right.command),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map(({ command }) => command);
}

function formatCliSuggestionLines(
  suggestions: readonly string[],
  commandPath: readonly string[],
): string {
  const commandPrefix = ["openclaw", ...commandPath].join(" ");
  const commandLines = suggestions
    .map((command) => `  ${formatCliCommand(`${commandPrefix} ${command}`)}`)
    .join("\n");
  return `Did you mean this?\n${commandLines}`;
}
