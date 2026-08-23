// Voice Call plugin module handles cli command input and output.
import { format } from "node:util";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";

export function writeCliLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

export function writeCliJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function parseCliInteger(
  raw: string | undefined,
  optionName: string,
  opts?: { min?: number; max?: number },
): number {
  const min = opts?.min ?? 0;
  const parsed = parseStrictNonNegativeInteger(raw?.trim() ?? "");
  if (parsed === undefined || parsed < min || (opts?.max !== undefined && parsed > opts.max)) {
    throw new Error(`Invalid numeric value for ${optionName}: ${raw ?? ""}`);
  }
  return parsed;
}
