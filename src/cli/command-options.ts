// Commander option-source helpers for explicit flags and bounded parent inheritance.
import type { Command, OptionValueSource } from "commander";

export function hasExplicitOptions(command: Command, names: readonly string[]): boolean {
  return names.some((name) => command.getOptionValueSource(name) === "cli");
}

export function listExplicitOptionFlagsExcept(
  command: Command,
  allowedNames: ReadonlySet<string>,
): string[] {
  const optionsByName = new Map<string, (typeof command.options)[number]>();
  for (const option of command.options) {
    const name = option.attributeName();
    if (allowedNames.has(name) || command.getOptionValueSource(name) !== "cli") {
      continue;
    }
    const existing = optionsByName.get(name);
    const valueIsNegated = command.getOptionValue(name) === false;
    if (!existing || option.negate === valueIsNegated) {
      optionsByName.set(name, option);
    }
  }
  return [...optionsByName.values()]
    .map((option) => option.long ?? option.short ?? option.flags)
    .toSorted();
}

// Defensive guardrail: allow expected parent/grandparent inheritance without unbounded deep traversal.
const MAX_INHERIT_DEPTH = 2;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Commander option values are typed by the caller.
export function inheritOptionFromParent<T = unknown>(
  command: Command | undefined,
  name: string,
  requiredSource?: OptionValueSource,
): T | undefined {
  if (!command) {
    return undefined;
  }

  const childSource = command.getOptionValueSource(name);
  if (childSource && childSource !== "default") {
    return undefined;
  }

  let depth = 0;
  let ancestor = command.parent;
  while (ancestor && depth < MAX_INHERIT_DEPTH) {
    const source = ancestor.getOptionValueSource(name);
    if (source && source !== "default") {
      if (requiredSource && source !== requiredSource) {
        return undefined;
      }
      return ancestor.getOptionValue(name) as T | undefined;
    }
    depth += 1;
    ancestor = ancestor.parent;
  }
  return undefined;
}
