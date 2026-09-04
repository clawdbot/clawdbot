import type { ConfigSchemaLookupResult as ProtocolConfigSchemaLookupResult } from "../../packages/gateway-protocol/src/schema/config.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import type { ConfigUiHint, ConfigUiHints } from "./schema.hints.js";
import {
  asSchemaObject,
  findWildcardHintMatch,
  schemaHasChildren,
  type ConfigJsonSchemaObject as JsonSchemaObject,
  type ConfigSchemaResponse,
} from "./schema.shared.js";

type JsonSchemaNode = Record<string, unknown>;

const FORBIDDEN_LOOKUP_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const LOOKUP_SCHEMA_STRING_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "format",
  "pattern",
  "contentEncoding",
  "contentMediaType",
]);
const LOOKUP_SCHEMA_NUMBER_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const LOOKUP_SCHEMA_BOOLEAN_KEYS = new Set([
  "additionalProperties",
  "uniqueItems",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const MAX_LOOKUP_PATH_SEGMENTS = 32;
const LOOKUP_SCHEMA_COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;
const LOOKUP_SCHEMA_NESTED_FORM_DEPTH = 4;

type ConfigSchemaLookupChild = ProtocolConfigSchemaLookupResult["children"][number];
type ConfigSchemaReloadKind = NonNullable<ProtocolConfigSchemaLookupResult["reloadKind"]>;

type ConfigSchemaReloadMetadata = {
  kind: ConfigSchemaReloadKind;
};

type ConfigSchemaReloadMetadataResolver = (
  path: string,
) => ConfigSchemaReloadMetadata | null | undefined;

type ConfigSchemaLookupResult = Omit<ProtocolConfigSchemaLookupResult, "schema"> & {
  schema: JsonSchemaNode;
};

function normalizeLookupPath(path: string): string {
  return path
    .trim()
    .replace(/\[(\*|\d*)\]/g, (_match, segment: string) => `.${segment || "*"}`)
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.+/g, ".");
}

function splitLookupPath(path: string): string[] {
  const normalized = normalizeLookupPath(path);
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

function resolveUiHintMatch(
  uiHints: ConfigUiHints,
  path: string,
): { path: string; hint: ConfigUiHint } | null {
  return findWildcardHintMatch({
    uiHints,
    path,
    splitPath: splitLookupPath,
  });
}

function resolveItemsSchema(schema: JsonSchemaObject, index?: number): JsonSchemaObject | null {
  if (Array.isArray(schema.items)) {
    const entry =
      index === undefined
        ? schema.items.find((candidate) => typeof candidate === "object" && candidate !== null)
        : schema.items[index];
    return entry && typeof entry === "object" ? entry : null;
  }
  return schema.items && typeof schema.items === "object" ? schema.items : null;
}

function resolveLookupChildSchema(
  schema: JsonSchemaObject,
  segment: string,
): JsonSchemaObject | null {
  if (FORBIDDEN_LOOKUP_SEGMENTS.has(segment)) {
    return null;
  }

  const properties = schema.properties;
  if (properties && Object.hasOwn(properties, segment)) {
    return asSchemaObject(properties[segment]);
  }

  const itemIndex = parseConfigPathArrayIndex(segment);
  const items = resolveItemsSchema(schema, itemIndex);
  if ((segment === "*" || itemIndex !== undefined) && items) {
    return items;
  }

  for (const key of LOOKUP_SCHEMA_COMPOSITION_KEYS) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const variantSchema = asSchemaObject(variant);
      const resolved = variantSchema ? resolveLookupChildSchema(variantSchema, segment) : null;
      if (resolved) {
        return resolved;
      }
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return schema.additionalProperties;
  }

  return null;
}

type ConfigSchemaPathSegmentKind = "property" | "record-key" | "array-index" | "invalid-record-key";

function classifyLookupChildSchema(
  schema: JsonSchemaObject,
  segment: string,
): ConfigSchemaPathSegmentKind | null {
  if (schema.properties && Object.hasOwn(schema.properties, segment)) {
    return "property";
  }
  if (parseConfigPathArrayIndex(segment) !== undefined && resolveItemsSchema(schema)) {
    return "array-index";
  }
  for (const key of LOOKUP_SCHEMA_COMPOSITION_KEYS) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const variantSchema = asSchemaObject(variant);
      const kind = variantSchema ? classifyLookupChildSchema(variantSchema, segment) : null;
      if (kind) {
        return kind;
      }
    }
  }
  if (schema.additionalProperties === true || typeof schema.additionalProperties === "object") {
    return propertyNameSchemaAllows(schema.propertyNames, segment)
      ? "record-key"
      : "invalid-record-key";
  }
  return null;
}

const PROPERTY_NAME_SCHEMA_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "pattern",
  "minLength",
  "maxLength",
  "anyOf",
  "oneOf",
  "allOf",
]);

function propertyNameSchemaAllows(schema: unknown, value: string): boolean {
  if (schema === undefined || schema === true) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  const object = asSchemaObject(schema);
  if (!object || Object.keys(object).some((key) => !PROPERTY_NAME_SCHEMA_KEYS.has(key))) {
    return false;
  }
  const types = Array.isArray(object.type) ? object.type : [object.type];
  if (object.type !== undefined && !types.includes("string")) {
    return false;
  }
  if (object.const !== undefined && object.const !== value) {
    return false;
  }
  if (Array.isArray(object.enum) && !object.enum.includes(value)) {
    return false;
  }
  if (typeof object.minLength === "number" && value.length < object.minLength) {
    return false;
  }
  if (typeof object.maxLength === "number" && value.length > object.maxLength) {
    return false;
  }
  if (typeof object.pattern === "string") {
    try {
      if (!new RegExp(object.pattern).test(value)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (object.allOf?.some((candidate) => !propertyNameSchemaAllows(candidate, value))) {
    return false;
  }
  if (
    object.anyOf &&
    !object.anyOf.some((candidate) => propertyNameSchemaAllows(candidate, value))
  ) {
    return false;
  }
  if (
    object.oneOf &&
    object.oneOf.filter((candidate) => propertyNameSchemaAllows(candidate, value)).length !== 1
  ) {
    return false;
  }
  return true;
}

/** Classify one already-parsed path segment without losing dots inside record keys. */
export function classifyConfigSchemaPathSegment(
  response: ConfigSchemaResponse,
  parentParts: readonly string[],
  segment: string,
): ConfigSchemaPathSegmentKind | null {
  let current = asSchemaObject(response.schema);
  if (!current) {
    return null;
  }
  for (const parentPart of parentParts) {
    const next = resolveLookupChildSchema(current, parentPart);
    if (!next) {
      return null;
    }
    current = next;
  }
  return classifyLookupChildSchema(current, segment);
}

function stripSchemaForLookup(schema: JsonSchemaObject, nestedFormDepth = 0): JsonSchemaNode {
  const next: JsonSchemaNode = {};

  for (const [key, value] of Object.entries(schema)) {
    if (LOOKUP_SCHEMA_STRING_KEYS.has(key) && typeof value === "string") {
      next[key] = value;
      continue;
    }
    if (LOOKUP_SCHEMA_NUMBER_KEYS.has(key) && typeof value === "number") {
      next[key] = value;
      continue;
    }
    if (LOOKUP_SCHEMA_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
      next[key] = value;
      continue;
    }
    if (key === "type") {
      if (typeof value === "string") {
        next[key] = value;
      } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        next[key] = [...value];
      }
      continue;
    }
    if (key === "enum" && Array.isArray(value)) {
      const entries = value.filter(
        (entry) =>
          entry === null ||
          typeof entry === "string" ||
          typeof entry === "number" ||
          typeof entry === "boolean",
      );
      if (entries.length === value.length) {
        next[key] = [...entries];
      }
      continue;
    }
    if (
      key === "const" &&
      (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    ) {
      next[key] = value;
    }
  }

  if (
    schema.properties &&
    ((nestedFormDepth > 0 && nestedFormDepth <= LOOKUP_SCHEMA_NESTED_FORM_DEPTH) ||
      (schema.additionalProperties && typeof schema.additionalProperties === "object"))
  ) {
    next.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, child]) => [
        key,
        stripSchemaForLookup(child, nestedFormDepth + 1),
      ]),
    );
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    next.additionalProperties = stripSchemaForLookup(
      schema.additionalProperties,
      nestedFormDepth + 1,
    );
  }
  if (Array.isArray(schema.items)) {
    next.items = schema.items.map((item) => stripSchemaForLookup(item, nestedFormDepth + 1));
  } else if (schema.items && typeof schema.items === "object") {
    next.items = stripSchemaForLookup(schema.items, nestedFormDepth + 1);
  }
  if (nestedFormDepth <= LOOKUP_SCHEMA_NESTED_FORM_DEPTH) {
    for (const key of LOOKUP_SCHEMA_COMPOSITION_KEYS) {
      const variants = schema[key];
      if (!Array.isArray(variants)) {
        continue;
      }
      next[key] = variants
        .filter((variant) => variant && typeof variant === "object")
        .map((variant) => stripSchemaForLookup(variant, nestedFormDepth + 1));
    }
  }

  return next;
}

function buildLookupChildren(
  schema: JsonSchemaObject,
  path: string,
  uiHints: ConfigUiHints,
  resolveReloadMetadata?: ConfigSchemaReloadMetadataResolver,
): ConfigSchemaLookupChild[] {
  const children: ConfigSchemaLookupChild[] = [];
  const required = new Set(schema.required ?? []);

  const pushChild = (key: string, childSchema: JsonSchemaObject, isRequired: boolean) => {
    const childPath = path ? `${path}.${key}` : key;
    const resolvedHint = resolveUiHintMatch(uiHints, childPath);
    const reloadMetadata = resolveReloadMetadata?.(childPath);
    children.push({
      key,
      path: childPath,
      type: childSchema.type,
      required: isRequired,
      hasChildren: schemaHasChildren(childSchema),
      reloadKind: reloadMetadata?.kind,
      hint: resolvedHint?.hint,
      hintPath: resolvedHint?.path,
    });
  };

  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    pushChild(key, childSchema, required.has(key));
  }

  const wildcardSchema =
    (schema.additionalProperties &&
    typeof schema.additionalProperties === "object" &&
    !Array.isArray(schema.additionalProperties)
      ? schema.additionalProperties
      : null) ?? resolveItemsSchema(schema);
  if (wildcardSchema) {
    pushChild("*", wildcardSchema, false);
  }

  return children;
}

export function lookupConfigSchema(
  response: ConfigSchemaResponse,
  path: string,
  resolveReloadMetadata?: ConfigSchemaReloadMetadataResolver,
): ConfigSchemaLookupResult | null {
  const wantsRoot = path.trim() === ".";
  const normalizedPath = normalizeLookupPath(path);
  if (!normalizedPath && !wantsRoot) {
    return null;
  }
  const parts = splitLookupPath(normalizedPath);
  if ((!wantsRoot && parts.length === 0) || parts.length > MAX_LOOKUP_PATH_SEGMENTS) {
    return null;
  }

  let current = asSchemaObject(response.schema);
  if (!current) {
    return null;
  }
  for (const segment of parts) {
    const next = resolveLookupChildSchema(current, segment);
    if (!next) {
      return null;
    }
    current = next;
  }

  const resolvedHint = resolveUiHintMatch(response.uiHints, normalizedPath);
  const reloadMetadata = resolveReloadMetadata?.(normalizedPath);
  return {
    path: wantsRoot ? "." : normalizedPath,
    schema: stripSchemaForLookup(current),
    reloadKind: reloadMetadata?.kind,
    hint: resolvedHint?.hint,
    hintPath: resolvedHint?.path,
    children: buildLookupChildren(
      current,
      wantsRoot ? "" : normalizedPath,
      response.uiHints,
      resolveReloadMetadata,
    ),
  };
}
