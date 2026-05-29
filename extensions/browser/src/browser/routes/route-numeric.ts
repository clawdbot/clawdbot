import {
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";

function hasRouteInputValue(value: unknown): boolean {
  return value != null;
}

export function readRouteFiniteNumber(value: unknown, fieldName: string): number | undefined {
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return parsed;
}

export function readOptionalRouteFiniteNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return readRouteFiniteNumber(value, fieldName);
}

export function readRouteInteger(
  value: unknown,
  fieldName: string,
  options?: { invalidMessage?: string },
): number | undefined {
  const parsed = parseStrictInteger(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(options?.invalidMessage ?? `${fieldName} must be an integer.`);
  }
  return parsed;
}

export function readRoutePositiveInteger(
  value: unknown,
  fieldName: string,
  options?: { invalidMessage?: string },
): number | undefined {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(options?.invalidMessage ?? `${fieldName} must be a positive integer.`);
  }
  return parsed;
}

export function readRouteNonNegativeInteger(
  value: unknown,
  fieldName: string,
  options?: { invalidMessage?: string },
): number | undefined {
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(options?.invalidMessage ?? `${fieldName} must be a non-negative integer.`);
  }
  return parsed;
}
