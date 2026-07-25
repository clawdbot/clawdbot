import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderToolSchemaDiagnostic,
} from "openclaw/plugin-sdk/plugin-entry";
import { findUnsupportedSchemaKeywords } from "openclaw/plugin-sdk/provider-tools";

const PERPLEXITY_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
]);
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "$defs",
  "definitions",
  "dependentSchemas",
  // Legacy `dependencies` mixes schema values with property-name arrays; the
  // walker leaves non-record values untouched, so both forms stay valid.
  "dependencies",
]);
const SCHEMA_VALUE_KEYS = new Set([
  "items",
  "additionalItems",
  "prefixItems",
  "anyOf",
  "oneOf",
  "allOf",
  "then",
  "else",
  "if",
  "not",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// JSON Schema allows `type` to be an array; a union containing "object" still
// admits objects, so it needs `properties` for Perplexity too.
function isObjectType(type: unknown): boolean {
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}

function normalizeSchemaMap(value: unknown): unknown {
  const record = readRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, schema]) => [key, normalizePerplexitySchema(schema)]),
  );
}

function normalizePerplexitySchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizePerplexitySchema);
  }
  const record = readRecord(value);
  if (!record) {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (PERPLEXITY_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    normalized[key] = SCHEMA_MAP_KEYS.has(key)
      ? normalizeSchemaMap(child)
      : SCHEMA_VALUE_KEYS.has(key)
        ? normalizePerplexitySchema(child)
        : child;
  }
  if (isObjectType(normalized.type) && !("properties" in normalized)) {
    normalized.properties = {};
  }
  return normalized;
}

function findObjectSchemasMissingProperties(schema: unknown, path: string): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((child, index) =>
      findObjectSchemasMissingProperties(child, `${path}[${index}]`),
    );
  }
  const record = readRecord(schema);
  if (!record) {
    return [];
  }
  const violations =
    isObjectType(record.type) && !("properties" in record) ? [`${path}.properties`] : [];
  for (const [key, child] of Object.entries(record)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      const schemas = readRecord(child);
      if (schemas) {
        for (const [name, nestedSchema] of Object.entries(schemas)) {
          violations.push(
            ...findObjectSchemasMissingProperties(nestedSchema, `${path}.${key}.${name}`),
          );
        }
      }
      continue;
    }
    if (SCHEMA_VALUE_KEYS.has(key)) {
      violations.push(...findObjectSchemasMissingProperties(child, `${path}.${key}`));
    }
  }
  return violations;
}

export function normalizePerplexityToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: normalizePerplexitySchema(tool.parameters) as AnyAgentTool["parameters"],
    };
  });
}

export function inspectPerplexityToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const path = `${tool.name}.parameters`;
    const violations = [
      ...findUnsupportedSchemaKeywords(
        tool.parameters,
        path,
        PERPLEXITY_UNSUPPORTED_SCHEMA_KEYWORDS,
      ),
      ...findObjectSchemasMissingProperties(tool.parameters, path),
    ];
    return violations.length > 0 ? [{ toolName: tool.name, toolIndex, violations }] : [];
  });
}
