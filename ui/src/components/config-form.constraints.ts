// Control UI helpers derive native constraints and safe initial values from config schemas.
import { schemaType, type JsonSchema } from "./config-form.shared.ts";
import {
  configValuesEqual,
  decimalRational,
  isSupportedConfigValueValid,
  ownPropertySchema,
} from "./config-form.validation.ts";

export { configValuesEqual, isSupportedConfigValueValid } from "./config-form.validation.ts";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CONFIG_FORM_DECIMAL_NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

export function coerceConfigFormNumberString(
  value: string,
  integer: boolean,
): number | undefined | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (!CONFIG_FORM_DECIMAL_NUMBER_RE.test(trimmed)) {
    return value;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    return value;
  }
  return parsed;
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  const [coefficient = "", exponentText] = text.split("e");
  const fractionLength = coefficient.split(".")[1]?.length ?? 0;
  const exponent = Number(exponentText ?? 0);
  return Math.max(0, fractionLength - exponent);
}

function normalizePrecision(value: number, step: number | undefined): number {
  if (!step) {
    return value;
  }
  const places = decimalPlaces(step);
  return places <= 100 ? Number(value.toFixed(places)) : value;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function leastCommonMultiple(left: bigint, right: bigint): bigint {
  return (left / greatestCommonDivisor(left, right)) * right;
}

function integerCompatibleStep(multipleOf: number): number {
  const [coefficient = "", exponentText] = String(multipleOf).toLowerCase().split("e");
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const exponent = Number(exponentText ?? 0);
  const digits = BigInt(`${whole}${fraction}`);
  const denominatorExponent = fraction.length - exponent;
  const numerator = denominatorExponent < 0 ? digits * 10n ** BigInt(-denominatorExponent) : digits;
  const denominator = denominatorExponent > 0 ? 10n ** BigInt(denominatorExponent) : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);
  const step = Number(numerator / divisor);
  if (!Number.isFinite(step) || step <= 0) {
    return 1;
  }
  return step;
}

function alignToStep(value: number, step: number, direction: "ceil" | "floor" | "round"): number {
  const valueRational = decimalRational(value);
  const stepRational = decimalRational(step);
  if (!valueRational || !stepRational || stepRational.numerator === 0n) {
    return value;
  }
  const dividend = valueRational.numerator * stepRational.denominator;
  const divisor = valueRational.denominator * stepRational.numerator;
  const truncated = dividend / divisor;
  const remainder = dividend % divisor;
  const floor = remainder < 0n ? truncated - 1n : truncated;
  const aligned =
    direction === "floor"
      ? floor
      : direction === "ceil"
        ? remainder === 0n
          ? truncated
          : remainder > 0n
            ? truncated + 1n
            : truncated
        : (dividend - floor * divisor) * 2n < divisor
          ? floor
          : floor + 1n;
  return normalizePrecision(Number(aligned) * step, step);
}

type NumericInputConstraints = {
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
  step: number | "any";
};

type ArrayInputConstraints = {
  minItems: number;
  maxItems?: number;
  uniqueItems: boolean;
};

type EffectiveNumericBound = {
  value?: number;
  exclusive: boolean;
};

function collectAllOfSchemas(schema: JsonSchema): JsonSchema[] {
  const result: JsonSchema[] = [];
  const pending = [schema];
  const seen = new Set<JsonSchema>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    result.push(current);
    for (let index = (current.allOf?.length ?? 0) - 1; index >= 0; index -= 1) {
      const entry = current.allOf?.[index];
      if (entry) {
        pending.push(entry);
      }
    }
  }
  return result;
}

function effectiveNumericBound(
  schemas: JsonSchema[],
  direction: "lower" | "upper",
): EffectiveNumericBound {
  let value: number | undefined;
  let exclusive = false;
  for (const schema of schemas) {
    const inclusiveCandidate = finiteNumber(
      direction === "lower" ? schema.minimum : schema.maximum,
    );
    const exclusiveCandidate = finiteNumber(
      direction === "lower" ? schema.exclusiveMinimum : schema.exclusiveMaximum,
    );
    for (const [candidate, candidateExclusive] of [
      [inclusiveCandidate, false],
      [exclusiveCandidate, true],
    ] as const) {
      if (
        candidate !== undefined &&
        (value === undefined ||
          (direction === "lower" ? candidate > value : candidate < value) ||
          (candidate === value && candidateExclusive && !exclusive))
      ) {
        value = candidate;
        exclusive = candidateExclusive;
      }
    }
  }
  return { value, exclusive };
}

function combinedMultipleOf(schemas: JsonSchema[]): number | undefined {
  let numerator: bigint | undefined;
  let denominator: bigint | undefined;
  for (const schema of schemas) {
    const multipleOf = finiteNumber(schema.multipleOf);
    if (multipleOf === undefined || multipleOf <= 0) {
      continue;
    }
    const rational = decimalRational(multipleOf);
    if (!rational) {
      continue;
    }
    const divisor = greatestCommonDivisor(rational.numerator, rational.denominator);
    const nextNumerator = rational.numerator / divisor;
    const nextDenominator = rational.denominator / divisor;
    numerator =
      numerator === undefined ? nextNumerator : leastCommonMultiple(numerator, nextNumerator);
    denominator =
      denominator === undefined
        ? nextDenominator
        : greatestCommonDivisor(denominator, nextDenominator);
  }
  if (numerator === undefined || denominator === undefined) {
    return undefined;
  }
  const combined = Number(numerator) / Number(denominator);
  return Number.isFinite(combined) && combined > 0 ? combined : undefined;
}

export function arrayInputConstraints(schema: JsonSchema): ArrayInputConstraints {
  const schemas = collectAllOfSchemas(schema);
  let minItems = 0;
  let maxItems: number | undefined;
  let uniqueItems = false;
  for (const entry of schemas) {
    if (
      Number.isSafeInteger(entry.minItems) &&
      entry.minItems !== undefined &&
      entry.minItems >= 0
    ) {
      minItems = Math.max(minItems, entry.minItems);
    }
    if (
      Number.isSafeInteger(entry.maxItems) &&
      entry.maxItems !== undefined &&
      entry.maxItems >= 0
    ) {
      maxItems = maxItems === undefined ? entry.maxItems : Math.min(maxItems, entry.maxItems);
    }
    if (Array.isArray(entry.items) && entry.additionalItems === false) {
      maxItems = Math.min(maxItems ?? Number.POSITIVE_INFINITY, entry.items.length);
    }
    uniqueItems ||= entry.uniqueItems === true;
  }
  return { minItems, maxItems, uniqueItems };
}

export function requiredPropertyKeys(schema: JsonSchema): Set<string> {
  return new Set(collectAllOfSchemas(schema).flatMap((entry) => entry.required ?? []));
}

export function objectPropertyKeys(schema: JsonSchema): string[] {
  const schemas = collectAllOfSchemas(schema);
  const keys = new Set<string>();
  for (const entry of schemas) {
    for (const key of Object.keys(entry.properties ?? {})) {
      keys.add(key);
    }
  }
  return [...keys].filter((key) =>
    schemas.every(
      (entry) =>
        ownPropertySchema(entry, key) !== undefined || entry.additionalProperties !== false,
    ),
  );
}

function combinedSchema(candidates: JsonSchema[]): JsonSchema | undefined {
  const base = candidates.find((candidate) => schemaType(candidate) !== undefined) ?? candidates[0];
  return !base || candidates.length === 1
    ? base
    : {
        ...base,
        allOf: [...(base.allOf ?? []), ...candidates.filter((candidate) => candidate !== base)],
      };
}

export function objectAdditionalPropertiesSchema(
  schema: JsonSchema,
): JsonSchema | false | undefined {
  const policies = collectAllOfSchemas(schema)
    .map((entry) => entry.additionalProperties)
    .filter((policy) => policy !== undefined);
  if (policies.some((policy) => policy === false)) {
    return false;
  }
  const schemas = policies.filter(
    (policy): policy is JsonSchema => Boolean(policy) && typeof policy === "object",
  );
  if (schemas.length > 0) {
    return combinedSchema(schemas);
  }
  return policies.some((policy) => policy === true) ? {} : undefined;
}

function objectRepairIssueCount(schema: JsonSchema, value: Record<string, unknown>): number {
  let issues = isSupportedConfigValueValid(schema, value) ? 0 : 1;
  const knownKeys = new Set(objectPropertyKeys(schema));
  for (const key of requiredPropertyKeys(schema)) {
    if (!Object.hasOwn(value, key)) {
      issues += 1;
    }
  }
  const additionalProperties = objectAdditionalPropertiesSchema(schema);
  for (const [key, entryValue] of Object.entries(value)) {
    const propertySchema = objectPropertySchema(schema, key);
    if (propertySchema) {
      if (!isSupportedConfigValueValid(propertySchema, entryValue)) {
        issues += 1;
      }
      continue;
    }
    if (
      !knownKeys.has(key) &&
      (additionalProperties === false ||
        additionalProperties === undefined ||
        !isSupportedConfigValueValid(additionalProperties, entryValue))
    ) {
      issues += 1;
    }
  }
  return issues;
}

export function canApplyObjectCandidate(
  schema: JsonSchema,
  current: Record<string, unknown>,
  candidate: Record<string, unknown>,
): boolean {
  if (isSupportedConfigValueValid(schema, candidate)) {
    return true;
  }
  if (isSupportedConfigValueValid(schema, current)) {
    return false;
  }
  return objectRepairIssueCount(schema, candidate) <= objectRepairIssueCount(schema, current);
}

export function objectPropertySchema(schema: JsonSchema, key: string): JsonSchema | undefined {
  if (!objectPropertyKeys(schema).includes(key)) {
    return undefined;
  }
  return combinedSchema(
    collectAllOfSchemas(schema)
      .map((entry) => ownPropertySchema(entry, key))
      .filter((property): property is JsonSchema => property !== undefined),
  );
}

export function arrayItemSchema(schema: JsonSchema, index: number): JsonSchema | undefined {
  const candidates: JsonSchema[] = [];
  for (const entry of collectAllOfSchemas(schema)) {
    if (Array.isArray(entry.items)) {
      const item =
        entry.items[index] ??
        (entry.additionalItems && typeof entry.additionalItems === "object"
          ? entry.additionalItems
          : undefined);
      if (item) {
        candidates.push(item);
      }
    } else if (entry.items) {
      candidates.push(entry.items);
    }
  }
  return combinedSchema(candidates);
}

export function arrayConstraintCandidates(
  schema: JsonSchema,
  seen = new Set<JsonSchema>(),
): unknown[][] {
  if (seen.has(schema)) {
    return [];
  }
  seen.add(schema);
  const candidates: unknown[][] = [];
  if (Array.isArray(schema.const)) {
    candidates.push(schema.const);
  }
  for (const entry of schema.enum ?? []) {
    if (Array.isArray(entry)) {
      candidates.push(entry);
    }
  }
  for (const entry of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    candidates.push(...arrayConstraintCandidates(entry, seen));
  }
  seen.delete(schema);
  return candidates;
}

function arrayCandidateDistance(value: readonly unknown[], candidate: readonly unknown[]): number {
  let distance = Math.abs(value.length - candidate.length);
  const sharedLength = Math.min(value.length, candidate.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (!configValuesEqual(value[index], candidate[index])) {
      distance += 1;
    }
  }
  return distance;
}

function arrayRepairIssueCount(
  schema: JsonSchema,
  value: readonly unknown[],
  uniqueItems: boolean,
): number {
  const { minItems, maxItems } = arrayInputConstraints(schema);
  let issues = Math.max(0, minItems - value.length);
  const constrainedDistances = arrayConstraintCandidates(schema)
    .filter((candidate) => isSupportedConfigValueValid(schema, candidate))
    .map((candidate) => arrayCandidateDistance(value, candidate));
  if (constrainedDistances.length > 0) {
    issues += Math.min(...constrainedDistances);
  }
  if (maxItems !== undefined) {
    issues += Math.max(0, value.length - maxItems);
  }
  for (let index = 0; index < value.length; index += 1) {
    const itemSchema = arrayItemSchema(schema, index);
    if (itemSchema && !isSupportedConfigValueValid(itemSchema, value[index])) {
      issues += 1;
    }
    if (
      uniqueItems &&
      value.slice(index + 1).some((candidate) => configValuesEqual(value[index], candidate))
    ) {
      issues += 1;
    }
  }
  return issues;
}

export function canApplyArrayCandidate(
  schema: JsonSchema,
  current: readonly unknown[],
  candidate: readonly unknown[],
  uniqueItems: boolean,
  allowEqualRepair: boolean,
): boolean {
  if (isSupportedConfigValueValid(schema, candidate)) {
    return true;
  }
  if (isSupportedConfigValueValid(schema, current)) {
    return false;
  }
  const currentIssues = arrayRepairIssueCount(schema, current, uniqueItems);
  const candidateIssues = arrayRepairIssueCount(schema, candidate, uniqueItems);
  return allowEqualRepair ? candidateIssues <= currentIssues : candidateIssues < currentIssues;
}

export function numericInputConstraints(schema: JsonSchema): NumericInputConstraints {
  const schemas = collectAllOfSchemas(schema);
  const numericTypes = new Set(
    schemas.flatMap((entry) => {
      const declaredTypes = Array.isArray(entry.type) ? entry.type : entry.type ? [entry.type] : [];
      return declaredTypes.includes("number")
        ? ["number"]
        : declaredTypes.includes("integer")
          ? ["integer"]
          : [];
    }),
  );
  const type = numericTypes.has("integer")
    ? "integer"
    : numericTypes.has("number")
      ? "number"
      : schemaType(schema);
  const multipleOf = combinedMultipleOf(schemas);
  const numericStep =
    type === "integer"
      ? multipleOf && multipleOf > 0
        ? integerCompatibleStep(multipleOf)
        : 1
      : multipleOf && multipleOf > 0
        ? multipleOf
        : undefined;
  const lowerBound = effectiveNumericBound(schemas, "lower");
  const upperBound = effectiveNumericBound(schemas, "upper");
  const rawMinimum = lowerBound.exclusive ? undefined : lowerBound.value;
  const rawMaximum = upperBound.exclusive ? undefined : upperBound.value;
  const exclusiveMinimum = lowerBound.exclusive ? lowerBound.value : undefined;
  const exclusiveMaximum = upperBound.exclusive ? upperBound.value : undefined;

  let min = rawMinimum ?? exclusiveMinimum;
  let max = rawMaximum ?? exclusiveMaximum;
  if (numericStep) {
    if (min !== undefined) {
      min = alignToStep(min, numericStep, "ceil");
    }
    if (max !== undefined) {
      max = alignToStep(max, numericStep, "floor");
    }
    if (exclusiveMinimum !== undefined) {
      const aligned = alignToStep(exclusiveMinimum, numericStep, "ceil");
      const exclusiveAligned =
        aligned <= exclusiveMinimum
          ? normalizePrecision(aligned + numericStep, numericStep)
          : aligned;
      min = min === undefined ? exclusiveAligned : Math.max(min, exclusiveAligned);
    }
    if (exclusiveMaximum !== undefined) {
      const aligned = alignToStep(exclusiveMaximum, numericStep, "floor");
      const exclusiveAligned =
        aligned >= exclusiveMaximum
          ? normalizePrecision(aligned - numericStep, numericStep)
          : aligned;
      max = max === undefined ? exclusiveAligned : Math.min(max, exclusiveAligned);
    }
  }

  return {
    min,
    max,
    exclusiveMin: exclusiveMinimum,
    exclusiveMax: exclusiveMaximum,
    step: numericStep ?? "any",
  };
}

function nextRepresentable(value: number, direction: 1 | -1): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  if (value === 0) {
    return direction > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;
  }
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const nextBits = value > 0 === direction > 0 ? bits + 1n : bits - 1n;
  view.setBigUint64(0, nextBits);
  return view.getFloat64(0);
}

function nextUsableNumber(value: number, direction: 1 | -1, opposite?: number): number {
  if (opposite !== undefined && Number.isFinite(opposite)) {
    const midpoint = value + (opposite - value) / 2;
    if ((direction > 0 && midpoint > value) || (direction < 0 && midpoint < value)) {
      return midpoint;
    }
  }
  const offset = Math.max(1, Math.abs(value));
  const candidate = value + direction * offset;
  if (Number.isFinite(candidate) && candidate !== value) {
    return candidate;
  }
  return nextRepresentable(value, direction);
}

export function normalizeNumericValue(value: number, schema: JsonSchema): number {
  const constraints = numericInputConstraints(schema);
  let normalized = value;
  if (typeof constraints.step === "number") {
    normalized = alignToStep(normalized, constraints.step, "round");
  }
  if (constraints.min !== undefined) {
    normalized = Math.max(constraints.min, normalized);
  }
  if (constraints.max !== undefined) {
    normalized = Math.min(constraints.max, normalized);
  }
  if (constraints.exclusiveMin !== undefined && normalized <= constraints.exclusiveMin) {
    normalized =
      typeof constraints.step === "number"
        ? nextRepresentable(constraints.exclusiveMin, 1)
        : nextRepresentable(constraints.exclusiveMin, 1);
  }
  if (constraints.exclusiveMax !== undefined && normalized >= constraints.exclusiveMax) {
    normalized =
      typeof constraints.step === "number"
        ? nextRepresentable(constraints.exclusiveMax, -1)
        : nextRepresentable(constraints.exclusiveMax, -1);
  }
  return normalizePrecision(
    normalized,
    typeof constraints.step === "number" ? constraints.step : undefined,
  );
}

export const NO_SAFE_DEFAULT = Symbol("no-safe-config-default");

const MAX_AUTO_STRING_DEFAULT_LENGTH = 4096;
export const MAX_AUTO_ARRAY_DEFAULT_ITEMS = 100;

function defaultNumericValue(schema: JsonSchema): number {
  const constraints = numericInputConstraints(schema);
  if (constraints.step === "any") {
    if (constraints.exclusiveMin !== undefined && constraints.exclusiveMin >= 0) {
      return nextUsableNumber(constraints.exclusiveMin, 1, constraints.max);
    }
    if (constraints.exclusiveMax !== undefined && constraints.exclusiveMax <= 0) {
      return nextUsableNumber(constraints.exclusiveMax, -1, constraints.min);
    }
  }
  return normalizeNumericValue(0, schema);
}

function defaultStringValue(schema: JsonSchema): string | typeof NO_SAFE_DEFAULT {
  const minLength = Math.max(0, schema.minLength ?? 0);
  const maxLength = schema.maxLength ?? Math.max(minLength, 0);
  if (
    !Number.isSafeInteger(minLength) ||
    minLength > MAX_AUTO_STRING_DEFAULT_LENGTH ||
    maxLength < minLength
  ) {
    return NO_SAFE_DEFAULT;
  }
  if (schema.pattern) {
    try {
      return minLength === 0 && new RegExp(schema.pattern, "u").test("") ? "" : NO_SAFE_DEFAULT;
    } catch {
      return NO_SAFE_DEFAULT;
    }
  }
  if (minLength === 0) {
    return "";
  }
  return "x".repeat(minLength).slice(0, maxLength);
}

function validatedDefaultCandidate(schema: JsonSchema, candidate: unknown): unknown {
  if (candidate === NO_SAFE_DEFAULT || !isSupportedConfigValueValid(schema, candidate)) {
    return NO_SAFE_DEFAULT;
  }
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }
  try {
    return structuredClone(candidate);
  } catch {
    return NO_SAFE_DEFAULT;
  }
}

export function defaultValue(schema?: JsonSchema, depth = 0): unknown {
  if (!schema) {
    return "";
  }
  if (schema.default !== undefined) {
    return validatedDefaultCandidate(schema, schema.default);
  }
  if (schema.const !== undefined) {
    return validatedDefaultCandidate(schema, schema.const);
  }
  if (schema.enum && schema.enum.length > 0) {
    for (const candidate of schema.enum) {
      const validated = validatedDefaultCandidate(schema, candidate);
      if (validated !== NO_SAFE_DEFAULT) {
        return validated;
      }
    }
    return NO_SAFE_DEFAULT;
  }
  if (depth >= 32) {
    return NO_SAFE_DEFAULT;
  }
  for (const entry of schema.allOf ?? []) {
    const candidate = defaultValue(entry, depth + 1);
    const validated = validatedDefaultCandidate(schema, candidate);
    if (validated !== NO_SAFE_DEFAULT) {
      return validated;
    }
  }
  const type = schemaType(schema);
  switch (type) {
    case "object": {
      const value: Record<string, unknown> = {};
      for (const key of schema.required ?? []) {
        const propertySchema = ownPropertySchema(schema, key);
        if (!propertySchema) {
          return NO_SAFE_DEFAULT;
        }
        const propertyDefault = defaultValue(propertySchema, depth + 1);
        if (propertyDefault === NO_SAFE_DEFAULT) {
          return NO_SAFE_DEFAULT;
        }
        value[key] = propertyDefault;
      }
      return validatedDefaultCandidate(schema, value);
    }
    case "array": {
      const itemCount = Math.max(0, schema.minItems ?? 0);
      if (!Number.isSafeInteger(itemCount) || itemCount > MAX_AUTO_ARRAY_DEFAULT_ITEMS) {
        return NO_SAFE_DEFAULT;
      }
      if (itemCount === 0) {
        return validatedDefaultCandidate(schema, []);
      }
      if (Array.isArray(schema.items)) {
        const value: unknown[] = [];
        for (let index = 0; index < itemCount; index += 1) {
          const itemSchema =
            schema.items[index] ??
            (schema.additionalItems && typeof schema.additionalItems === "object"
              ? schema.additionalItems
              : undefined);
          if (!itemSchema) {
            return NO_SAFE_DEFAULT;
          }
          const itemDefault = defaultValue(itemSchema, depth + 1);
          if (itemDefault === NO_SAFE_DEFAULT) {
            return NO_SAFE_DEFAULT;
          }
          value.push(itemDefault);
        }
        return validatedDefaultCandidate(schema, value);
      }
      const itemsSchema = schema.items;
      if (!itemsSchema) {
        return NO_SAFE_DEFAULT;
      }
      const value: unknown[] = [];
      for (let index = 0; index < itemCount; index += 1) {
        const itemDefault = defaultValue(itemsSchema, depth + 1);
        if (itemDefault === NO_SAFE_DEFAULT) {
          return NO_SAFE_DEFAULT;
        }
        value.push(itemDefault);
      }
      return validatedDefaultCandidate(schema, value);
    }
    case "boolean":
      return validatedDefaultCandidate(schema, false);
    case "number":
    case "integer": {
      const value = defaultNumericValue(schema);
      return validatedDefaultCandidate(schema, value);
    }
    case "string":
      return validatedDefaultCandidate(schema, defaultStringValue(schema));
    case "null":
      return validatedDefaultCandidate(schema, null);
    default:
      return validatedDefaultCandidate(schema, "");
  }
}
