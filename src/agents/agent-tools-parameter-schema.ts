/**
 * Normalizes model-facing tool parameter schemas across provider quirks.
 * Handles local JSON Schema refs, OpenAPI nullable syntax, top-level unions,
 * and provider-specific unsupported keyword stripping.
 */
import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import type { TSchema } from "typebox";
import type { ModelCompatConfig } from "../config/types.models.js";
import {
  resolveUnsupportedToolSchemaKeywords,
  shouldOmitEmptyArrayItems,
} from "../plugins/provider-model-compat.js";
import { stripUnsupportedSchemaKeywords } from "../shared/schema-keyword-strip.js";
import { cleanSchemaForGemini } from "./schema/clean-for-gemini.js";

export type ToolParameterSchemaOptions = {
  modelProvider?: string;
  modelId?: string;
  modelCompat?: ModelCompatConfig;
};

const MAX_TOOL_PARAMETER_SCHEMA_CACHE_ENTRIES_PER_SCHEMA = 8;
const toolParameterSchemaCache = new WeakMap<object, Array<{ key: string; value: TSchema }>>();

function resolveToolParameterSchemaCacheKey(
  options: ToolParameterSchemaOptions | undefined,
): string {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(options?.modelId);
  const unsupportedKeywords = Array.from(
    resolveUnsupportedToolSchemaKeywords(options?.modelCompat),
  ).toSorted();
  const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);
  return JSON.stringify([
    normalizedProvider,
    normalizedModelId,
    unsupportedKeywords,
    omitEmptyArrayItems,
  ]);
}

function getCachedToolParameterSchema(schema: object, key: string): TSchema | undefined {
  return toolParameterSchemaCache.get(schema)?.find((entry) => entry.key === key)?.value;
}

function rememberCachedToolParameterSchema(schema: object, key: string, value: TSchema): TSchema {
  const entries = toolParameterSchemaCache.get(schema) ?? [];
  toolParameterSchemaCache.set(
    schema,
    [{ key, value }, ...entries.filter((entry) => entry.key !== key)].slice(
      0,
      MAX_TOOL_PARAMETER_SCHEMA_CACHE_ENTRIES_PER_SCHEMA,
    ),
  );
  return value;
}

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    return record.enum;
  }
  if ("const" in record) {
    return [record.const];
  }
  const variants = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : null;
  if (variants) {
    const values = variants.flatMap((variant) => {
      const extracted = extractEnumValues(variant);
      return extracted ?? [];
    });
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (existingEnum || incomingEnum) {
    const values = uniqueValues([...(existingEnum ?? []), ...(incomingEnum ?? [])]);
    const merged: Record<string, unknown> = {};
    for (const source of [existing, incoming]) {
      if (!source || typeof source !== "object") {
        continue;
      }
      const record = source as Record<string, unknown>;
      for (const key of ["title", "description", "default"]) {
        if (!(key in merged) && key in record) {
          merged[key] = record[key];
        }
      }
    }
    const types = new Set(values.map((value) => typeof value));
    if (types.size === 1) {
      merged.type = Array.from(types)[0];
    }
    merged.enum = values;
    return merged;
  }

  return existing;
}

type FlattenableVariantKey = "anyOf" | "oneOf";
type TopLevelConditionalKey = FlattenableVariantKey | "allOf";

function setOwnSchemaProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function hasTopLevelArrayKeyword(
  schemaRecord: Record<string, unknown>,
  key: TopLevelConditionalKey,
): boolean {
  return Array.isArray(schemaRecord[key]);
}

function getFlattenableVariantKey(
  schemaRecord: Record<string, unknown>,
): FlattenableVariantKey | null {
  if (hasTopLevelArrayKeyword(schemaRecord, "anyOf")) {
    return "anyOf";
  }
  if (hasTopLevelArrayKeyword(schemaRecord, "oneOf")) {
    return "oneOf";
  }
  return null;
}

function getTopLevelConditionalKey(
  schemaRecord: Record<string, unknown>,
): TopLevelConditionalKey | null {
  return (
    getFlattenableVariantKey(schemaRecord) ??
    (hasTopLevelArrayKeyword(schemaRecord, "allOf") ? "allOf" : null)
  );
}

function hasTopLevelObjectSchema(
  schemaRecord: Record<string, unknown>,
  conditionalKey: TopLevelConditionalKey | null,
): boolean {
  return (
    schemaRecord.type === "object" &&
    isSchemaRecord(schemaRecord.properties) &&
    conditionalKey === null
  );
}

function isObjectLikeSchemaMissingType(
  schemaRecord: Record<string, unknown>,
  conditionalKey: TopLevelConditionalKey | null,
): boolean {
  return (
    !("type" in schemaRecord) &&
    (isSchemaRecord(schemaRecord.properties) || Array.isArray(schemaRecord.required)) &&
    conditionalKey === null
  );
}

function isTypedObjectSchemaMissingValidProperties(
  schemaRecord: Record<string, unknown>,
  conditionalKey: TopLevelConditionalKey | null,
): boolean {
  return (
    schemaRecord.type === "object" &&
    !isSchemaRecord(schemaRecord.properties) &&
    conditionalKey === null
  );
}

function isTrulyEmptySchema(schemaRecord: Record<string, unknown>): boolean {
  return Object.keys(schemaRecord).length === 0;
}

function normalizeArraySchemasMissingItems(schema: unknown): unknown {
  if (!isSchemaRecord(schema)) {
    return schema;
  }

  let changed = false;
  const nextSchema: Record<string, unknown> = { ...schema };
  if (nextSchema.type === "array" && nextSchema.items === undefined) {
    nextSchema.items = {};
    changed = true;
  }

  const normalizeSchemaValue = (key: string): void => {
    if (!(key in nextSchema)) {
      return;
    }
    const value = nextSchema[key];
    if (Array.isArray(value)) {
      const normalized = value.map(normalizeArraySchemasMissingItems);
      if (normalized.some((entry, index) => entry !== value[index])) {
        nextSchema[key] = normalized;
        changed = true;
      }
      return;
    }

    const normalized = normalizeArraySchemasMissingItems(value);
    if (normalized !== value) {
      nextSchema[key] = normalized;
      changed = true;
    }
  };

  for (const key of [
    "items",
    "contains",
    "additionalProperties",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
  ]) {
    normalizeSchemaValue(key);
  }

  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    normalizeSchemaValue(key);
  }

  for (const key of [
    "properties",
    "patternProperties",
    "dependentSchemas",
    "$defs",
    "definitions",
  ]) {
    const value = nextSchema[key];
    if (!isSchemaRecord(value)) {
      continue;
    }
    let entriesChanged = false;
    const normalizedEntries: Array<[string, unknown]> = Object.entries(value).map(
      ([entryKey, entryValue]) => {
        const normalizedEntryValue = normalizeArraySchemasMissingItems(entryValue);
        if (normalizedEntryValue !== entryValue) {
          entriesChanged = true;
        }
        return [entryKey, normalizedEntryValue];
      },
    );
    if (entriesChanged) {
      nextSchema[key] = Object.fromEntries(normalizedEntries);
      changed = true;
    }
  }

  return changed ? nextSchema : schema;
}

function schemaAllowsArrayType(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  return type === "array" || (Array.isArray(type) && type.includes("array"));
}

const ARRAY_ITEMS_SCHEMA_OBJECT_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
]);

const ARRAY_ITEMS_SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

const ARRAY_ITEMS_SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function stripEmptyArrayItemsFromArraySchemas(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const entries = schema.map((entry) => {
      const next = stripEmptyArrayItemsFromArraySchemas(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? entries : schema;
  }
  if (!isSchemaRecord(schema)) {
    return schema;
  }

  let changed = false;
  const entries = Object.entries(schema).flatMap(([key, value]) => {
    if (
      key === "items" &&
      schemaAllowsArrayType(schema) &&
      isSchemaRecord(value) &&
      isTrulyEmptySchema(value)
    ) {
      changed = true;
      return [];
    }

    if (ARRAY_ITEMS_SCHEMA_OBJECT_KEYS.has(key)) {
      const next = stripEmptyArrayItemsFromArraySchemas(value);
      changed ||= next !== value;
      return [[key, next] as const];
    }

    if (ARRAY_ITEMS_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      const next = stripEmptyArrayItemsFromArraySchemas(value);
      changed ||= next !== value;
      return [[key, next] as const];
    }

    if (ARRAY_ITEMS_SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      let mapChanged = false;
      const next = Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => {
          const entryNext = stripEmptyArrayItemsFromArraySchemas(entryValue);
          mapChanged ||= entryNext !== entryValue;
          return [entryKey, entryNext] as const;
        }),
      );
      changed ||= mapChanged;
      return [[key, mapChanged ? next : value] as const];
    }

    return [[key, value] as const];
  });
  return changed ? Object.fromEntries(entries) : schema;
}

type SchemaDefs = {
  $defs: Map<string, unknown>;
  definitions: Map<string, unknown>;
};

function copySchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of ["title", "description", "default"] as const) {
    if (key in from && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
}

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const defsEntry =
    schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : undefined;
  const legacyDefsEntry =
    schema.definitions &&
    typeof schema.definitions === "object" &&
    !Array.isArray(schema.definitions)
      ? (schema.definitions as Record<string, unknown>)
      : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next: SchemaDefs = defs
    ? {
        $defs: new Map(defs.$defs),
        definitions: new Map(defs.definitions),
      }
    : {
        $defs: new Map<string, unknown>(),
        definitions: new Map<string, unknown>(),
      };
  if (defsEntry) {
    for (const [key, value] of Object.entries(defsEntry)) {
      next.$defs.set(key, value);
    }
  }
  if (legacyDefsEntry) {
    for (const [key, value] of Object.entries(legacyDefsEntry)) {
      next.definitions.set(key, value);
    }
  }
  return next;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointerPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const key = decodeJsonPointerSegment(segment);
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, key)) {
      return undefined;
    }
    current = record[key];
  }
  return current;
}

function resolveLocalJsonPointer(rootDocument: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  return resolveJsonPointerPath(rootDocument, ref.slice(2).split("/"));
}

const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

const SCHEMA_OBJECT_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
]);

const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);

const SCHEMA_LITERAL_KEYS = new Set(["const", "default", "enum", "examples"]);

function tryResolveLocalRef(
  ref: string,
  defs: SchemaDefs | undefined,
  rootDocument: unknown,
): unknown {
  const match = ref.match(/^#\/(\$defs|definitions)\/([^/]+)(?:\/(.*))?$/);
  if (match && defs) {
    const namespace = match[1] === "$defs" ? defs.$defs : defs.definitions;
    const name = decodeJsonPointerSegment(match[2] ?? "");
    const resolved = name ? namespace.get(name) : undefined;
    if (resolved !== undefined) {
      const remainingPath = match[3] ? match[3].split("/") : [];
      return resolveJsonPointerPath(resolved, remainingPath);
    }
  }
  return resolveLocalJsonPointer(rootDocument, ref);
}

function inlineLocalSchemaRefsWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
  state: { unresolvedLocalRefs: boolean },
  rootDocument: unknown,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      inlineLocalSchemaRefsWithDefs(entry, defs, refStack, state, rootDocument),
    );
  }

  const obj = schema as Record<string, unknown>;
  const nextDefs = extendSchemaDefs(defs, obj);
  const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;

  if (refValue) {
    if (refStack?.has(refValue)) {
      return {};
    }
    const resolved = tryResolveLocalRef(refValue, nextDefs, rootDocument);
    if (resolved === undefined) {
      if (refValue.startsWith("#/")) {
        state.unresolvedLocalRefs = true;
      }
      return { ...obj };
    }
    const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
    nextRefStack.add(refValue);
    const inlined = inlineLocalSchemaRefsWithDefs(
      resolved,
      nextDefs,
      nextRefStack,
      state,
      rootDocument,
    );
    if (!inlined || typeof inlined !== "object" || Array.isArray(inlined)) {
      return inlined;
    }
    const result: Record<string, unknown> = { ...(inlined as Record<string, unknown>) };
    copySchemaMeta(obj, result);
    if (obj.nullable === true) {
      result.nullable = true;
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$defs" || key === "definitions" || key === "components") {
      continue;
    }
    if (SCHEMA_LITERAL_KEYS.has(key)) {
      setOwnSchemaProperty(result, key, value);
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      setOwnSchemaProperty(
        result,
        key,
        Object.fromEntries(
          Object.entries(value).map(([entryKey, entryValue]) => [
            entryKey,
            inlineLocalSchemaRefsWithDefs(entryValue, nextDefs, refStack, state, rootDocument),
          ]),
        ),
      );
      continue;
    }
    if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
      setOwnSchemaProperty(
        result,
        key,
        inlineLocalSchemaRefsWithDefs(value, nextDefs, refStack, state, rootDocument),
      );
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      setOwnSchemaProperty(
        result,
        key,
        value.map((entry) =>
          inlineLocalSchemaRefsWithDefs(entry, nextDefs, refStack, state, rootDocument),
        ),
      );
      continue;
    }
    setOwnSchemaProperty(result, key, value);
  }
  if (state.unresolvedLocalRefs) {
    if ("$defs" in obj) {
      result.$defs = obj.$defs;
    }
    if ("definitions" in obj) {
      result.definitions = obj.definitions;
    }
    if ("components" in obj) {
      result.components = obj.components;
    }
  }
  return result;
}

/** Inline local $ref pointers so providers receive self-contained tool schemas. */
export function inlineLocalToolSchemaRefs(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object") {
    return schema as TSchema;
  }
  const defs = extendSchemaDefs(undefined, schema as Record<string, unknown>);
  return inlineLocalSchemaRefsWithDefs(
    schema,
    defs,
    undefined,
    {
      unresolvedLocalRefs: false,
    },
    schema,
  ) as TSchema;
}

const OPENAPI_SCHEMA_ANNOTATION_KEYS = new Set([
  "discriminator",
  "externalDocs",
  "readOnly",
  "writeOnly",
  "xml",
  "example",
]);

function appendNullSchemaType(type: unknown): unknown {
  if (type === "null") {
    return type;
  }
  if (typeof type === "string") {
    return [type, "null"];
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? type : [...type, "null"];
  }
  return type;
}

function isNullSchemaLike(schema: unknown): boolean {
  if (!isSchemaRecord(schema)) {
    return false;
  }
  if (schema.type === "null") {
    return true;
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }
  if ("const" in schema && schema.const === null) {
    return true;
  }
  return Array.isArray(schema.enum) && schema.enum.includes(null);
}

function hasOpenApiComposition(schema: Record<string, unknown>): boolean {
  return ["allOf", "anyOf", "oneOf"].some((key) => Array.isArray(schema[key]));
}

function schemaCompositionAlreadyAllowsNull(schema: Record<string, unknown>): boolean {
  return (
    (Array.isArray(schema.anyOf) && schema.anyOf.some(isNullSchemaLike)) ||
    (Array.isArray(schema.oneOf) && schema.oneOf.some(isNullSchemaLike))
  );
}

function wrapNullableComposedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schemaCompositionAlreadyAllowsNull(schema)) {
    return schema;
  }
  const wrapped: Record<string, unknown> = {
    anyOf: [schema, { type: "null" }],
  };
  copySchemaMeta(schema, wrapped);
  return wrapped;
}

function normalizeOpenApiSchemaKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeOpenApiSchemaKeywords(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!isSchemaRecord(schema)) {
    return schema;
  }

  let changed = false;
  const nullable = schema.nullable === true;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "nullable" || OPENAPI_SCHEMA_ANNOTATION_KEYS.has(key)) {
      changed = true;
      continue;
    }
    if (SCHEMA_LITERAL_KEYS.has(key)) {
      normalized[key] = value;
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      let mapChanged = false;
      const next = Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => {
          const nextEntry = normalizeOpenApiSchemaKeywords(entryValue);
          mapChanged ||= nextEntry !== entryValue;
          return [entryKey, nextEntry];
        }),
      );
      normalized[key] = mapChanged ? next : value;
      changed ||= mapChanged;
      continue;
    }
    if (key === "components") {
      normalized[key] = value;
      continue;
    }
    if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
      const next = normalizeOpenApiSchemaKeywords(value);
      normalized[key] = next;
      changed ||= next !== value;
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      const next = value.map(normalizeOpenApiSchemaKeywords);
      normalized[key] = next;
      changed ||= next.some((entry, index) => entry !== value[index]);
      continue;
    }
    normalized[key] = value;
  }

  if (nullable) {
    if (hasOpenApiComposition(normalized)) {
      return wrapNullableComposedSchema(normalized);
    }
    if ("type" in normalized) {
      const nextType = appendNullSchemaType(normalized.type);
      if (nextType !== normalized.type) {
        normalized.type = nextType;
      }
    }
    if (Array.isArray(normalized.enum) && !normalized.enum.includes(null)) {
      normalized.enum = [...normalized.enum, null];
    }
  }

  return changed || nullable ? normalized : schema;
}

function normalizeToolParameterSchemaUncached(
  schema: unknown,
  options?: ToolParameterSchemaOptions,
): TSchema {
  const inlinedSchema = normalizeOpenApiSchemaKeywords(inlineLocalToolSchemaRefs(schema));
  const schemaRecord =
    inlinedSchema && typeof inlinedSchema === "object"
      ? (inlinedSchema as Record<string, unknown>)
      : undefined;
  if (!schemaRecord) {
    return inlinedSchema as TSchema;
  }

  // Provider quirks:
  // - Gemini rejects several JSON Schema keywords, so we scrub those.
  // - OpenAI rejects function tool schemas unless the *top-level* is `type: "object"`.
  //   (TypeBox root unions compile to `{ anyOf: [...] }` without `type`).
  // - Anthropic expects full JSON Schema draft 2020-12 compliance.
  // - xAI rejects validation-constraint keywords (minLength, maxLength, etc.) outright.
  //
  // Normalize once here so callers can always pass `tools` through unchanged.
  const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
  const isGeminiProvider =
    normalizedProvider.includes("google") || normalizedProvider.includes("gemini");
  const isAnthropicProvider = normalizedProvider.includes("anthropic");
  const unsupportedToolSchemaKeywords = resolveUnsupportedToolSchemaKeywords(options?.modelCompat);
  const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);

  function applyProviderCleaning(s: unknown): TSchema {
    const normalizedSchema = normalizeArraySchemasMissingItems(s);
    const arrayItemsCompatibleSchema = omitEmptyArrayItems
      ? stripEmptyArrayItemsFromArraySchemas(normalizedSchema)
      : normalizedSchema;
    if (isGeminiProvider && !isAnthropicProvider) {
      return cleanSchemaForGemini(arrayItemsCompatibleSchema);
    }
    if (unsupportedToolSchemaKeywords.size > 0) {
      return stripUnsupportedSchemaKeywords(
        arrayItemsCompatibleSchema,
        unsupportedToolSchemaKeywords,
      ) as TSchema;
    }
    return arrayItemsCompatibleSchema as TSchema;
  }

  const conditionalKey = getTopLevelConditionalKey(schemaRecord);
  const flattenableVariantKey = getFlattenableVariantKey(schemaRecord);

  if (hasTopLevelObjectSchema(schemaRecord, conditionalKey)) {
    return applyProviderCleaning(schemaRecord);
  }

  if (isObjectLikeSchemaMissingType(schemaRecord, conditionalKey)) {
    return applyProviderCleaning({
      ...schemaRecord,
      type: "object",
      properties: isSchemaRecord(schemaRecord.properties) ? schemaRecord.properties : {},
    });
  }

  if (isTypedObjectSchemaMissingValidProperties(schemaRecord, conditionalKey)) {
    return applyProviderCleaning({ ...schemaRecord, properties: {} });
  }

  if (!flattenableVariantKey) {
    if (isTrulyEmptySchema(schemaRecord)) {
      // Handle the proven MCP no-parameter case: a truly empty schema object.
      return applyProviderCleaning({ type: "object", properties: {} });
    }
    if (conditionalKey === "allOf") {
      // Top-level `allOf` is not safely flattenable with the same heuristics we
      // use for unions. Keep it explicit rather than silently rewriting it.
      return applyProviderCleaning(inlinedSchema);
    }
    return applyProviderCleaning(inlinedSchema);
  }
  const variants = schemaRecord[flattenableVariantKey] as unknown[];
  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of variants) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const props = (entry as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") {
      continue;
    }
    objectVariants += 1;
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      if (!(key in mergedProperties)) {
        mergedProperties[key] = value;
        continue;
      }
      mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value);
    }
    const required = Array.isArray((entry as { required?: unknown }).required)
      ? (entry as { required: unknown[] }).required
      : [];
    for (const key of required) {
      if (typeof key !== "string") {
        continue;
      }
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  const baseRequired = Array.isArray(schemaRecord.required)
    ? schemaRecord.required.filter((key) => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([key]) => key)
        : undefined;

  const nextSchema: Record<string, unknown> = { ...schemaRecord };
  const flattenedSchema = {
    type: "object",
    ...(typeof nextSchema.title === "string" ? { title: nextSchema.title } : {}),
    ...(typeof nextSchema.description === "string" ? { description: nextSchema.description } : {}),
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : (schemaRecord.properties ?? {}),
    ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    additionalProperties:
      "additionalProperties" in schemaRecord ? schemaRecord.additionalProperties : true,
  };

  // Flatten union schemas into a single object schema:
  // - Gemini doesn't allow top-level `type` together with `anyOf`.
  // - OpenAI rejects schemas without top-level `type: "object"`.
  // - Anthropic accepts proper JSON Schema with constraints.
  // Merging properties preserves useful enums like `action` while keeping schemas portable.
  return applyProviderCleaning(flattenedSchema);
}

/** Return a provider-compatible JSON schema for a model-facing tool. */
export function normalizeToolParameterSchema(
  schema: unknown,
  options?: ToolParameterSchemaOptions,
): TSchema {
  if (!schema || typeof schema !== "object") {
    return normalizeToolParameterSchemaUncached(schema, options);
  }
  const cacheKey = resolveToolParameterSchemaCacheKey(options);
  const cached = getCachedToolParameterSchema(schema, cacheKey);
  if (cached) {
    return cached;
  }
  return rememberCachedToolParameterSchema(
    schema,
    cacheKey,
    normalizeToolParameterSchemaUncached(schema, options),
  );
}
