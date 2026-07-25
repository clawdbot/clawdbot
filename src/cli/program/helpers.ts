// Shared Commander registration helpers for repeated options and positive integers.
import { InvalidArgumentError } from "commander";
import { parseStrictPositiveInteger } from "../../infra/parse-finite-number.js";

/** Commander option collector for repeatable string flags. */
export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Parse an optional positive integer, treating empty values as unset. */
export function parsePositiveIntOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return parseStrictPositiveInteger(value);
}

/** Parse a positive integer without treating empty values specially. */
export function parseStrictPositiveIntOrUndefined(value: unknown): number | undefined {
  return parseStrictPositiveInteger(value);
}

/** Commander argument parser for required positive integer options. */
export function parseStrictPositiveIntOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError(`${flag} must be a positive integer.`);
  }
  return parsed;
}
