// Qa Lab plugin module implements cli options behavior.
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";

export function invalidQaCliArgument(message: string): Error & { code: string; exitCode: number } {
  return Object.assign(new Error(message), {
    name: "InvalidArgumentError",
    code: "commander.invalidArgument",
    exitCode: 1,
  });
}

export function parseQaCliPositiveIntegerOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw invalidQaCliArgument(`${flag} must be a positive integer.`);
  }
  return parsed;
}

export function collectString(value: string, previous: string[]) {
  const trimmed = value.trim();
  return trimmed ? [...previous, trimmed] : previous;
}
