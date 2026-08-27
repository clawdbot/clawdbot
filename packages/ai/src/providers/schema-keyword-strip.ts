// This helper accepts draft-07 through 2020-12 schemas. Keep the union of
// schema-bearing keys aligned with the package's dialect-specific walkers.
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  // Draft-07 dependencies mix schemas with property-name arrays. Recursive
  // stripping leaves the string entries in those arrays unchanged.
  "dependencies",
  "patternProperties",
  "properties",
]);

/** Containers whose value is a single nested schema. */
const SCHEMA_OBJECT_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Containers whose value is a list of nested schemas. */
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);

/** Recursively remove schema keywords unsupported by a target provider/tool surface. */
export function stripUnsupportedSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupportedKeywords));
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (unsupportedKeywords.has(key)) {
      continue;
    }
    // Schema containers hold nested schemas under different shapes. Recurse
    // through each known container while preserving unrelated metadata fields.
    if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          stripUnsupportedSchemaKeywords(childValue, unsupportedKeywords),
        ]),
      );
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      cleaned[key] = value.map((entry) =>
        stripUnsupportedSchemaKeywords(entry, unsupportedKeywords),
      );
      continue;
    }
    if (SCHEMA_OBJECT_KEYS.has(key) && value && typeof value === "object") {
      cleaned[key] = stripUnsupportedSchemaKeywords(value, unsupportedKeywords);
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}
