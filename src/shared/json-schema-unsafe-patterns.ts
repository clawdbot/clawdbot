import { compileJsonSchemaPatternRegexDetailed } from "../security/safe-regex.js";

// Only real child-schema keywords can contain patternProperties that TypeBox
// will compile as regexes. Do not recurse into annotation literals
// (default, const, examples, description, …).
const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies", // schema-valued entries only; property-name arrays are skipped below
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

function asSchemaRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>; // SAFETY: caller already excluded arrays and primitives.
}

/** Locate nested-repetition patternProperties that TypeBox would compile unsafely. */
export function findUnsafePatternProperty(schema: unknown, path = "$"): string | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  if (Array.isArray(schema)) {
    for (let i = 0; i < schema.length; i += 1) {
      const nested = findUnsafePatternProperty(schema[i], `${path}[${i}]`);
      if (nested) {
        return nested;
      }
    }
    return null;
  }
  const record = asSchemaRecord(schema);
  const patterns = record.patternProperties;
  if (patterns && typeof patterns === "object" && !Array.isArray(patterns)) {
    for (const pattern of Object.keys(asSchemaRecord(patterns))) {
      const compiled = compileJsonSchemaPatternRegexDetailed(pattern);
      if (!compiled.regex && compiled.reason === "unsafe-nested-repetition") {
        return `${path}.patternProperties[${JSON.stringify(pattern)}]`;
      }
    }
  }
  for (const key of schemaMapKeywords) {
    const value = record[key];
    if (value === undefined || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    for (const [entryKey, entry] of Object.entries(asSchemaRecord(value))) {
      // dependencies may map to property-name arrays; only schema objects nest patterns.
      if (Array.isArray(entry) || typeof entry !== "object" || entry === null) {
        continue;
      }
      const nested = findUnsafePatternProperty(entry, `${path}.${key}.${entryKey}`);
      if (nested) {
        return nested;
      }
    }
  }
  for (const key of schemaValueKeywords) {
    const value = record[key];
    if (value === undefined || typeof value === "boolean") {
      continue;
    }
    if (Array.isArray(value)) {
      if (key !== "items") {
        continue;
      }
      for (let i = 0; i < value.length; i += 1) {
        const nested = findUnsafePatternProperty(value[i], `${path}.${key}[${i}]`);
        if (nested) {
          return nested;
        }
      }
      continue;
    }
    const nested = findUnsafePatternProperty(value, `${path}.${key}`);
    if (nested) {
      return nested;
    }
  }
  for (const key of schemaArrayKeywords) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (let i = 0; i < value.length; i += 1) {
      const nested = findUnsafePatternProperty(value[i], `${path}.${key}[${i}]`);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}
