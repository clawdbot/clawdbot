// Browser-safe JSON Schema normalization and value checks shared by core and Control UI.
import { Guard } from "typebox/guard";
import { Check } from "typebox/schema";
import { isRecord } from "./record-coerce.js";

type JsonSchemaObject = Record<string, unknown>;
export type JsonSchemaValue = JsonSchemaObject | boolean;

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const schemaValueKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaResourceKeywords = new Set([
  "$anchor",
  "$defs",
  "$dynamicAnchor",
  "$id",
  "$recursiveAnchor",
  "$schema",
  "$vocabulary",
  "definitions",
]);

function normalizeSchemaMap(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeJsonSchemaNode(entry)]),
  );
}

function compilesUnicodePattern(pattern: string): boolean {
  try {
    const probe = new RegExp(pattern, "u");
    void probe;
    return true;
  } catch {
    return false;
  }
}

function repairJsonSchemaPatternForUnicodeRegExp(pattern: string): string {
  if (compilesUnicodePattern(pattern)) {
    return pattern;
  }
  const repaired = pattern.replace(/\\([^\\])/g, (match, ch: string) => {
    if (ch === ":" || ch === "/") {
      return ch;
    }
    return match;
  });
  return compilesUnicodePattern(repaired) ? repaired : pattern;
}

function normalizeSchemaDependencies(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isStringArray(entry) ? entry : normalizeJsonSchemaNode(entry),
    ]),
  );
}

function normalizePatternProperties(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = new Map<string, unknown>();
  for (const [pattern, propertySchema] of Object.entries(value)) {
    const repairedPattern = repairJsonSchemaPatternForUnicodeRegExp(pattern);
    const repairedSchema = normalizeJsonSchemaNode(propertySchema);
    const existingSchema = normalized.get(repairedPattern);
    normalized.set(
      repairedPattern,
      existingSchema === undefined ? repairedSchema : { allOf: [existingSchema, repairedSchema] },
    );
  }
  return Object.fromEntries(normalized);
}

function expandJsonSchemaTypeArray(schema: Record<string, unknown>): Record<string, unknown> {
  const { nullable, type, ...rest } = schema;
  const types = Array.isArray(type) ? [...type] : typeof type === "string" ? [type] : null;
  if (!types) {
    return schema;
  }
  if (nullable === true && !types.includes("null")) {
    types.push("null");
  }
  if (types.length === 1 && !Array.isArray(type)) {
    return schema;
  }
  const entries = Object.entries(rest);
  const resourceEntries = entries.filter(([key]) => schemaResourceKeywords.has(key));
  const branch = Object.fromEntries(entries.filter(([key]) => !schemaResourceKeywords.has(key)));
  // Keep value-wide constraints on every branch: const, enum, and applicators
  // must still decide whether null is valid. Type-specific keywords ignore null.
  return {
    ...Object.fromEntries(resourceEntries),
    anyOf: types.map((entry) => Object.assign({}, branch, { type: entry })),
  };
}

function normalizeAdditionalPropertiesSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !isRecord(schema.additionalProperties) ||
    isRecord(schema.properties) ||
    isRecord(schema.patternProperties)
  ) {
    return schema;
  }
  const { additionalProperties, ...rest } = schema;
  return {
    ...rest,
    patternProperties: {
      ".*": additionalProperties,
    },
    additionalProperties: false,
  };
}

function normalizeJsonSchemaNode(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeJsonSchemaNode(entry));
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const schemaWithNullableEnum =
    schema.nullable === true &&
    schema.enumIncludesNull === true &&
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => entry === null)
      ? { ...schema, enum: [...schema.enum, null] }
      : schema;
  const normalizedSchema = normalizeAdditionalPropertiesSchema(
    expandJsonSchemaTypeArray(schemaWithNullableEnum),
  );
  return Object.fromEntries(
    Object.entries(normalizedSchema).map(([key, value]) => {
      if (key === "$dynamicRef" && normalizedSchema.$ref === undefined) {
        return ["$ref", value];
      }
      if (key === "pattern" && typeof value === "string") {
        return [key, repairJsonSchemaPatternForUnicodeRegExp(value)];
      }
      if (key === "patternProperties" && isRecord(value)) {
        return [key, normalizePatternProperties(value)];
      }
      if (schemaMapKeywords.has(key)) {
        return [key, normalizeSchemaMap(value)];
      }
      if (key === "dependencies") {
        return [key, normalizeSchemaDependencies(value)];
      }
      if (schemaValueKeywords.has(key) || schemaArrayKeywords.has(key)) {
        return [key, normalizeJsonSchemaNode(value)];
      }
      return [key, value];
    }),
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isJsonValue(
  value: unknown,
  active = new WeakSet<object>(),
  complete = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  let entries: unknown[];
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((key) => {
          if (key === "length") {
            return false;
          }
          if (typeof key !== "string") {
            return true;
          }
          const index = Number(key);
          return (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          );
        })
      ) {
        return false;
      }
      entries = value;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.some(
          (key) =>
            typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key),
        )
      ) {
        return false;
      }
      entries = Object.values(value);
    }
  } catch {
    return false;
  }
  if (complete.has(value)) {
    return true;
  }
  if (active.has(value)) {
    return false;
  }
  active.add(value);
  const valid = entries.every((entry) => isJsonValue(entry, active, complete));
  active.delete(value);
  if (valid) {
    complete.add(value);
  }
  return valid;
}

/** Normalize JSON Schema constructs into the TypeBox runtime subset used by validators. */
export function normalizeJsonSchemaForTypeBox(schema: JsonSchemaValue): JsonSchemaValue {
  return normalizeJsonSchemaNode(schema) as JsonSchemaValue;
}

/** Compare acyclic JSON values using the same equality semantics as TypeBox. */
export function jsonSchemaValuesEqual(left: unknown, right: unknown): boolean {
  if (!isJsonValue(left) || !isJsonValue(right)) {
    return false;
  }
  try {
    return Guard.IsDeepEqual(left, right);
  } catch {
    return false;
  }
}

/** Validate an acyclic JSON value against the canonical normalized schema. */
export function isJsonSchemaValueValid(schema: JsonSchemaValue, value: unknown): boolean {
  if (!isJsonValue(value)) {
    return false;
  }
  try {
    return Check(normalizeJsonSchemaForTypeBox(schema) as never, value);
  } catch {
    return false;
  }
}
