// Shared Commander registration helpers for repeated options and positive integers.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { InvalidArgumentError } from "commander";

/** Commander option collector for repeatable string flags. */
export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Commander argument parser for required positive integer options. */
export function parseStrictPositiveIntOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError(`${flag} must be a positive integer.`);
  }
  return parsed;
}
