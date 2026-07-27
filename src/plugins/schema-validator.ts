// Compiles plugin manifest schemas for validation without runtime loading.
import { Compile, type Validator as TypeBoxValidator } from "typebox/compile";
import { Format } from "typebox/format";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import {
  applyJsonSchemaDefaults,
  findJsonSchemaShapeError,
  normalizeJsonSchemaForTypeBox,
} from "../shared/json-schema-defaults.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { PluginLruCache } from "./plugin-cache-primitives.js";

type TypeBoxValidationError = {
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  params?: Record<string, unknown>;
  message?: string;
};

type CachedValidator = {
  hasDefaults: boolean;
  validate: TypeBoxValidator;
  schema: JsonSchemaValue;
  schemaFingerprint: string;
};

/**
 * JSON Schema document accepted by plugin config and SDK runtime validation.
 * Boolean schemas are valid draft-style schemas and must remain accepted here.
 */
export type JsonSchemaValue = JsonSchemaObject | boolean;

const schemaCache = new PluginLruCache<CachedValidator>(512);
const annotationOnlyFormats = [
  "date-time",
  "date",
  "duration",
  "email",
  "hostname",
  "idn-email",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "iri-reference",
  "iri",
  "json-pointer-uri-fragment",
  "json-pointer",
  "regex",
  "relative-json-pointer",
  "time",
  "uri-reference",
  "uri-template",
  "url",
  "uuid",
] as const;

function fingerprintSchema(schema: JsonSchemaValue): string {
  return JSON.stringify(schema);
}

function schemaHasDefaults(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") {
    return false;
  }
  if (Array.isArray(schema)) {
    return schema.some((item) => schemaHasDefaults(item));
  }
  const record = schema as Record<string, unknown>;
  if (Object.hasOwn(record, "default")) {
    return true;
  }
  return Object.values(record).some((value) => schemaHasDefaults(value));
}

function cloneValidationValue<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  return structuredClone(value);
}

function compileSchema(schema: JsonSchemaValue): TypeBoxValidator {
  return Compile(normalizeJsonSchemaForTypeBox(schema) as never);
}

function relaxConditionalRequiredKeywords(
  schema: JsonSchemaValue,
  insideConditionalBranch = false,
): JsonSchemaValue {
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      relaxConditionalRequiredKeywords(entry as JsonSchemaValue, insideConditionalBranch),
    ) as never;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !(insideConditionalBranch && key === "required"))
      .map(([key, value]) => [
        key,
        typeof value === "boolean" || (value && typeof value === "object")
          ? relaxConditionalRequiredKeywords(
              value as JsonSchemaValue,
              insideConditionalBranch || key === "then" || key === "else",
            )
          : value,
      ]),
  ) as JsonSchemaValue;
}

function withPluginFormatSemantics<T>(callback: () => T): T {
  const previousFormats = Format.Entries();
  // TypeBox format checks are global; snapshot/restore keeps plugin schema semantics local.
  Format.Set("uri", (value) => URL.canParse(value));
  for (const format of annotationOnlyFormats) {
    Format.Set(format, () => true);
  }
  try {
    return callback();
  } finally {
    Format.Clear();
    for (const [format, check] of previousFormats) {
      Format.Set(format, check);
    }
  }
}

function checkSchema(validate: TypeBoxValidator, value: unknown): TypeBoxValidationError[] | null {
  return withPluginFormatSemantics(() => {
    if (validate.Check(value)) {
      return null;
    }
    return [...validate.Errors(value)] as TypeBoxValidationError[];
  });
}

function applyDefaultsWithPluginFormatSemantics(schema: JsonSchemaValue, value: unknown): unknown {
  return withPluginFormatSemantics(() => applyJsonSchemaDefaults(schema, value));
}

function isDefaultActivatedConditionalFailure(params: {
  schema: JsonSchemaValue;
  originalValue: unknown;
  defaultedValue: unknown;
}): boolean {
  const relaxedConditionalValidator = compileSchema(
    relaxConditionalRequiredKeywords(params.schema),
  );
  if (checkSchema(relaxedConditionalValidator, params.defaultedValue)) {
    return false;
  }
  const originalValidator = compileSchema(params.schema);
  return checkSchema(originalValidator, params.originalValue) === null;
}

/**
 * Sanitized validation error surfaced to config diagnostics, gateway hooks, and SDK callers.
 * `path`/`message` stay raw for programmatic handling; `text` is terminal-safe display text.
 */
export type JsonSchemaValidationError = {
  path: string;
  message: string;
  text: string;
  additionalProperty?: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

function normalizeErrorPath(instancePath: string | undefined): string {
  const path = instancePath?.replace(/^\//, "").replace(/\//g, ".");
  return path && path.length > 0 ? path : "<root>";
}

function appendPathSegment(path: string, segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) {
    return path;
  }
  if (path === "<root>") {
    return trimmed;
  }
  return `${path}.${trimmed}`;
}

function firstStringParam(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value.find(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
    return first ?? null;
  }
  return null;
}

function resolveMissingProperty(error: TypeBoxValidationError): string | null {
  if (
    error.keyword !== "required" &&
    error.keyword !== "dependentRequired" &&
    error.keyword !== "dependencies"
  ) {
    return null;
  }
  return (
    firstStringParam(error.params?.missingProperty) ??
    firstStringParam(error.params?.requiredProperties) ??
    firstStringParam(error.params?.dependencies)
  );
}

function resolveValidationErrorPath(error: TypeBoxValidationError): string {
  const basePath = normalizeErrorPath(error.instancePath);
  const missingProperty = resolveMissingProperty(error);
  if (!missingProperty) {
    return basePath;
  }
  return appendPathSegment(basePath, missingProperty);
}

function extractAllowedValues(error: TypeBoxValidationError): unknown[] | null {
  if (error.keyword === "enum") {
    const allowedValues = error.params?.allowedValues;
    return Array.isArray(allowedValues) ? allowedValues : null;
  }

  if (error.keyword === "const") {
    const params = error.params;
    if (!params || !Object.hasOwn(params, "allowedValue")) {
      return null;
    }
    return [params.allowedValue];
  }

  return null;
}

function getAllowedValuesSummary(
  error: TypeBoxValidationError,
): ReturnType<typeof summarizeAllowedValues> {
  const allowedValues = extractAllowedValues(error);
  if (!allowedValues) {
    return null;
  }
  return summarizeAllowedValues(allowedValues);
}

function resolveAdditionalProperty(error: TypeBoxValidationError): string | undefined {
  if (error.keyword !== "additionalProperties") {
    return undefined;
  }
  return firstStringParam(error.params?.additionalProperty) ?? undefined;
}

function resolveAdditionalProperties(error: TypeBoxValidationError): string[] {
  if (error.keyword !== "additionalProperties") {
    return [];
  }
  const additionalProperties = error.params?.additionalProperties;
  if (Array.isArray(additionalProperties)) {
    return additionalProperties.filter((entry): entry is string => typeof entry === "string");
  }
  const additionalProperty = error.params?.additionalProperty;
  return typeof additionalProperty === "string" ? [additionalProperty] : [];
}

function formatRequiredMessage(error: TypeBoxValidationError): string | null {
  const missingProperty = resolveMissingProperty(error);
  if (!missingProperty) {
    return null;
  }
  return `must have required property ${JSON.stringify(missingProperty)}`;
}

function formatAdditionalPropertiesMessage(error: TypeBoxValidationError): string | null {
  const additionalProperties = resolveAdditionalProperties(error);
  if (additionalProperties.length === 0) {
    return null;
  }
  const quoted = additionalProperties.map((entry) => JSON.stringify(entry)).join(", ");
  return `must not have additional properties: ${quoted}`;
}

function formatValidationErrorMessage(error: TypeBoxValidationError): string {
  return (
    formatRequiredMessage(error) ??
    formatAdditionalPropertiesMessage(error) ??
    error.message ??
    "invalid"
  );
}

function formatValidationErrors(
  errors: TypeBoxValidationError[] | null | undefined,
): JsonSchemaValidationError[] {
  if (!errors || errors.length === 0) {
    return [{ path: "<root>", message: "invalid config", text: "<root>: invalid config" }];
  }
  return errors.map((error) => {
    const path = resolveValidationErrorPath(error);
    const baseMessage = formatValidationErrorMessage(error);
    const allowedValuesSummary = getAllowedValuesSummary(error);
    const additionalProperty = resolveAdditionalProperty(error);
    const message = allowedValuesSummary
      ? appendAllowedValuesHint(baseMessage, allowedValuesSummary)
      : baseMessage;
    const safePath = sanitizeTerminalText(path);
    const safeMessage = sanitizeTerminalText(message);
    return {
      path,
      message,
      text: `${safePath}: ${safeMessage}`,
      ...(additionalProperty ? { additionalProperty } : {}),
      ...(allowedValuesSummary
        ? {
            allowedValues: allowedValuesSummary.values,
            allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
          }
        : {}),
    };
  });
}

/**
 * Validate a plugin-owned value against a JSON Schema, optionally hydrating schema defaults.
 * The cache key is caller-owned so repeated plugin/schema validations can reuse compiled TypeBox validators.
 */
export function validateJsonSchemaValue(params: {
  schema: JsonSchemaValue;
  cacheKey: string;
  value: unknown;
  applyDefaults?: boolean;
  cache?: boolean;
}): { ok: true; value: unknown } | { ok: false; errors: JsonSchemaValidationError[] } {
  const schemaError = findJsonSchemaShapeError(params.schema);
  if (schemaError) {
    throw new Error(sanitizeTerminalText(`invalid schema: ${schemaError}`));
  }

  const useCache = params.cache !== false;
  if (!useCache) {
    const validate = compileSchema(params.schema);
    const value =
      params.applyDefaults && schemaHasDefaults(params.schema)
        ? applyDefaultsWithPluginFormatSemantics(params.schema, cloneValidationValue(params.value))
        : params.value;
    const errors = checkSchema(validate, value);
    if (!errors) {
      return { ok: true, value };
    }
    if (
      params.applyDefaults &&
      value !== params.value &&
      isDefaultActivatedConditionalFailure({
        schema: params.schema,
        originalValue: params.value,
        defaultedValue: value,
      })
    ) {
      // Defaults can select a conditional branch that requires the defaulted property;
      // keep the hydrated value when the original input was valid before hydration.
      return { ok: true, value };
    }
    return { ok: false, errors: formatValidationErrors(errors) };
  }

  const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
  let cached = schemaCache.get(cacheKey);
  const schemaFingerprint =
    !cached || cached.schema !== params.schema ? fingerprintSchema(params.schema) : undefined;
  if (
    !cached ||
    (cached.schema !== params.schema && cached.schemaFingerprint !== schemaFingerprint)
  ) {
    const validate = compileSchema(params.schema);
    cached = {
      hasDefaults: params.applyDefaults ? schemaHasDefaults(params.schema) : false,
      validate,
      schema: params.schema,
      schemaFingerprint: schemaFingerprint ?? fingerprintSchema(params.schema),
    };
    schemaCache.set(cacheKey, cached);
  } else if (cached.schema !== params.schema) {
    cached.schema = params.schema;
  }

  const value =
    params.applyDefaults && cached.hasDefaults
      ? applyDefaultsWithPluginFormatSemantics(params.schema, cloneValidationValue(params.value))
      : params.value;
  const errors = checkSchema(cached.validate, value);
  if (!errors) {
    return { ok: true, value };
  }
  if (
    params.applyDefaults &&
    value !== params.value &&
    isDefaultActivatedConditionalFailure({
      schema: params.schema,
      originalValue: params.value,
      defaultedValue: value,
    })
  ) {
    // Same conditional-default exception as the uncached path; cache only changes validator reuse.
    return { ok: true, value };
  }
  return { ok: false, errors: formatValidationErrors(errors) };
}
