/**
 * OpenAI strict JSON-schema normalization for tool inventories and request payloads.
 *
 * Caches normalized object inputs by provider compatibility so repeated inventory builds preserve identity.
 */
import {
  MAX_TOOL_SCHEMA_NESTING_DEPTH,
  normalizeToolParameterSchema,
  SCHEMA_LITERAL_KEYS,
  SCHEMA_MAP_KEYS,
  shouldOmitEmptyArrayItems,
  ToolSchemaDepthLimitError,
  type ToolSchemaModelCompat,
} from "./agent-tools-parameter-schema.js";
import type { OpenAIToolProjection } from "./openai-tool-projection.js";
import { findOpenAIStrictSchemaViolations } from "./openai-tool-schema-compat.js";

export { findOpenAIStrictSchemaViolations } from "./openai-tool-schema-compat.js";

/**
 * OpenAI strict-tool-schema normalization and diagnostics.
 *
 * Strict schemas need all object properties required and `additionalProperties: false`; model
 * compatibility settings can also remove unsupported schema constructs before strict checks run.
 */
type ToolSchemaCompatInput = {
  unsupportedToolSchemaKeywords?: unknown;
  omitEmptyArrayItems?: unknown;
};

const MAX_STRICT_SCHEMA_CACHE_ENTRIES_PER_SCHEMA = 8;
const strictOpenAISchemaCache = new WeakMap<object, Array<{ key: string; value: unknown }>>();

function resolveToolSchemaModelCompat(
  compat: ToolSchemaCompatInput | null | undefined,
): ToolSchemaModelCompat | undefined {
  if (!compat) {
    return undefined;
  }
  const unsupportedToolSchemaKeywords = Array.isArray(compat.unsupportedToolSchemaKeywords)
    ? compat.unsupportedToolSchemaKeywords.filter(
        (keyword): keyword is string => typeof keyword === "string",
      )
    : [];
  if (unsupportedToolSchemaKeywords.length === 0 && compat.omitEmptyArrayItems !== true) {
    return undefined;
  }
  return {
    ...(unsupportedToolSchemaKeywords.length > 0 ? { unsupportedToolSchemaKeywords } : {}),
    ...(compat.omitEmptyArrayItems === true ? { omitEmptyArrayItems: true } : {}),
  };
}

function resolveStrictOpenAISchemaCacheKey(
  modelCompat: ToolSchemaCompatInput | null | undefined,
): string {
  const compat = resolveToolSchemaModelCompat(modelCompat);
  return JSON.stringify([
    [...(compat?.unsupportedToolSchemaKeywords ?? [])].toSorted(),
    shouldOmitEmptyArrayItems(compat),
  ]);
}

function readCachedStrictOpenAISchema(schema: object, key: string): unknown {
  return strictOpenAISchemaCache.get(schema)?.find((entry) => entry.key === key)?.value;
}

function rememberStrictOpenAISchema(schema: object, key: string, value: unknown): unknown {
  const entries = strictOpenAISchemaCache.get(schema) ?? [];
  strictOpenAISchemaCache.set(
    schema,
    [{ key, value }, ...entries.filter((entry) => entry.key !== key)].slice(
      0,
      MAX_STRICT_SCHEMA_CACHE_ENTRIES_PER_SCHEMA,
    ),
  );
  return value;
}

/** Normalizes a tool parameter schema into the OpenAI strict JSON-schema subset. */
export function normalizeStrictOpenAIJsonSchema(
  schema: unknown,
  modelCompat?: ToolSchemaCompatInput | null,
): unknown {
  const schemaInput = schema ?? {};
  if (!schemaInput || typeof schemaInput !== "object") {
    return normalizeStrictOpenAIJsonSchemaRecursive(
      normalizeToolParameterSchema(schemaInput, {
        modelCompat: resolveToolSchemaModelCompat(modelCompat),
      }),
      0,
    );
  }
  const cacheKey = resolveStrictOpenAISchemaCacheKey(modelCompat);
  const cached = readCachedStrictOpenAISchema(schemaInput, cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  return rememberStrictOpenAISchema(
    schemaInput,
    cacheKey,
    // Cache by input object and compatibility key so repeated inventory generation preserves object
    // identity without mixing schemas normalized for different provider limitations.
    normalizeStrictOpenAIJsonSchemaRecursive(
      normalizeToolParameterSchema(schemaInput, {
        modelCompat: resolveToolSchemaModelCompat(modelCompat),
      }),
      0,
    ),
  );
}

function normalizeStrictOpenAIJsonSchemaRecursive(schema: unknown, depth: number): unknown {
  // Shares the tool-schema depth convention: descending into a child schema node costs one
  // level, containers cost zero, literal payloads never recurse. Without the cap a hostile MCP
  // schema nested past the stack limit overflows as a RangeError mid-request.
  if (depth > MAX_TOOL_SCHEMA_NESTING_DEPTH) {
    throw new ToolSchemaDepthLimitError();
  }
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      // Scalar entries (required lists, type unions) are payloads, not child schema nodes.
      const next =
        !entry || typeof entry !== "object"
          ? entry
          : normalizeStrictOpenAIJsonSchemaRecursive(entry, depth + 1);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  let changed = false;
  const normalized = Object.fromEntries<unknown>(
    Object.entries(record).map(([key, value]) => {
      // Schema-map entries are user-named subschemas — a property can be called "default" — so
      // traverse each entry value before the literal-keyword exemption below can apply.
      if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        let mapChanged = false;
        const nextMap = Object.fromEntries(
          // SAFETY: value is narrowed to a non-null, non-array object above.
          Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => {
            const nextEntry =
              !entryValue || typeof entryValue !== "object"
                ? entryValue
                : normalizeStrictOpenAIJsonSchemaRecursive(entryValue, depth + 1);
            mapChanged ||= nextEntry !== entryValue;
            return [entryKey, nextEntry];
          }),
        );
        changed ||= mapChanged;
        return [key, mapChanged ? nextMap : value];
      }
      // Draft-07 dependencies mix subschemas with property-name arrays: normalize only the
      // subschema values, keep name lists byte-identical. Entry names are user-chosen, so this
      // branch must also win over the literal exemption (dependencies.default is a subschema).
      if (key === "dependencies" && value && typeof value === "object" && !Array.isArray(value)) {
        let depsChanged = false;
        const nextDeps = Object.fromEntries(
          // SAFETY: value is narrowed to a non-null, non-array object above.
          Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => {
            if (Array.isArray(entryValue)) {
              return [entryKey, entryValue];
            }
            const nextEntry =
              !entryValue || typeof entryValue !== "object"
                ? entryValue
                : normalizeStrictOpenAIJsonSchemaRecursive(entryValue, depth + 1);
            depsChanged ||= nextEntry !== entryValue;
            return [entryKey, nextEntry];
          }),
        );
        changed ||= depsChanged;
        return [key, depsChanged ? nextDeps : value];
      }
      // Literal payloads (const/default/enum/examples) are values, not schemas: preserve them
      // without recursion so their depth can neither trip the cap nor abort request construction.
      if (SCHEMA_LITERAL_KEYS.has(key)) {
        return [key, value];
      }
      const next =
        // Scalars are payloads, not child schema nodes: they cost no depth. Arrays are
        // transparent containers whose object elements pay the one level — the same convention
        // the inliner uses, so 130 nested single-element allOf chains measure 130 in every walker.
        !value || typeof value !== "object"
          ? value
          : normalizeStrictOpenAIJsonSchemaRecursive(
              value,
              Array.isArray(value) ? depth : depth + 1,
            );
      changed ||= next !== value;
      return [key, next];
    }),
  );

  if (normalized.type === "object") {
    const properties =
      normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)
        ? (normalized.properties as Record<string, unknown>)
        : undefined;
    if (properties && Object.keys(properties).length === 0 && !Array.isArray(normalized.required)) {
      normalized.required = [];
      changed = true;
    }
    if (depth === 0 && !("additionalProperties" in normalized)) {
      normalized.additionalProperties = false;
      changed = true;
    }
  }

  return changed ? normalized : schema;
}

/** Normalizes tool parameters using strict OpenAI rules only when strict mode is active. */
export function normalizeOpenAIStrictToolParameters<T>(
  schema: T,
  strict: boolean,
  modelCompat?: ToolSchemaCompatInput | null,
): T {
  const toolSchemaCompat = resolveToolSchemaModelCompat(modelCompat);
  if (!strict) {
    return normalizeToolParameterSchema(schema ?? {}, { modelCompat: toolSchemaCompat }) as T;
  }
  return normalizeStrictOpenAIJsonSchema(schema, toolSchemaCompat) as T;
}

/** Returns whether a schema already satisfies OpenAI strict tool-schema constraints. */
export function isStrictOpenAIJsonSchemaCompatible(schema: unknown): boolean {
  return isStrictOpenAIJsonSchemaCompatibleRecursive(normalizeStrictOpenAIJsonSchema(schema), 0);
}

type OpenAIStrictToolSchemaDiagnostic = {
  toolIndex: number;
  toolName?: string;
  violations: string[];
};

/** Returns strict-schema diagnostics for an already materialized OpenAI tool projection. */
export function findOpenAIStrictToolProjectionDiagnostics(
  projection: OpenAIToolProjection,
): OpenAIStrictToolSchemaDiagnostic[] {
  return [
    ...projection.diagnostics.map((diagnostic) => ({
      toolIndex: diagnostic.toolIndex,
      ...(diagnostic.toolName ? { toolName: diagnostic.toolName } : {}),
      violations: [...diagnostic.violations],
    })),
    ...projection.tools.flatMap((tool) => {
      const violations = findOpenAIStrictSchemaViolations(
        normalizeStrictOpenAIJsonSchema(tool.parameters),
        `${tool.name}.parameters`,
      );
      return violations.length > 0
        ? [{ toolIndex: tool.toolIndex, toolName: tool.name, violations }]
        : [];
    }),
  ];
}

function isStrictOpenAIJsonSchemaCompatibleRecursive(schema: unknown, depth: number): boolean {
  if (depth > MAX_TOOL_SCHEMA_NESTING_DEPTH) {
    throw new ToolSchemaDepthLimitError();
  }
  if (Array.isArray(schema)) {
    return schema.every(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        isStrictOpenAIJsonSchemaCompatibleRecursive(entry, depth + 1),
    );
  }
  if (!schema || typeof schema !== "object") {
    return true;
  }

  const record = schema as Record<string, unknown>;
  if ("anyOf" in record || "oneOf" in record || "allOf" in record) {
    return false;
  }
  if (Array.isArray(record.type)) {
    return false;
  }
  if (record.type === "object" && record.additionalProperties !== false) {
    return false;
  }
  if (record.type === "object") {
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      return false;
    }
    const requiredSet = new Set(required);
    if (Object.keys(properties).some((key) => !requiredSet.has(key))) {
      return false;
    }
  }

  return Object.entries(record).every(([key, entry]) => {
    // Literal payloads are values, not schemas — nothing to check inside them.
    if (SCHEMA_LITERAL_KEYS.has(key)) {
      return true;
    }
    // Schema-map entry names are user-chosen, never keywords; check each subschema value.
    if (SCHEMA_MAP_KEYS.has(key) && entry && typeof entry === "object" && !Array.isArray(entry)) {
      // SAFETY: entry is narrowed to a non-null, non-array object above.
      return Object.values(entry as Record<string, unknown>).every(
        (value) =>
          !value ||
          typeof value !== "object" ||
          isStrictOpenAIJsonSchemaCompatibleRecursive(value, depth + 1),
      );
    }
    // Draft-07 dependencies: subschema values must be compatible; property-name arrays pass.
    if (key === "dependencies" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      // SAFETY: entry is narrowed to a non-null, non-array object above.
      return Object.values(entry as Record<string, unknown>).every(
        (value) =>
          Array.isArray(value) ||
          !value ||
          typeof value !== "object" ||
          isStrictOpenAIJsonSchemaCompatibleRecursive(value, depth + 1),
      );
    }
    return (
      // Scalars are payloads, not child schema nodes — nothing to check and no depth to pay.
      !entry ||
      typeof entry !== "object" ||
      isStrictOpenAIJsonSchemaCompatibleRecursive(
        entry,
        // Same transparent-container convention as the normalizer: array elements pay the level.
        Array.isArray(entry) ? depth : depth + 1,
      )
    );
  });
}

/** Resolves strict mode for the projected tools that will be emitted in the request payload. */
export function resolveOpenAIProjectedToolsStrictToolFlag(
  projection: OpenAIToolProjection,
  strict: boolean | null | undefined,
): boolean | undefined {
  if (strict !== true) {
    return strict === false ? false : undefined;
  }
  return projection.tools.every((tool) => isStrictOpenAIJsonSchemaCompatible(tool.parameters));
}
