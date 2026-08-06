import { normalizeJsonSchemaForTypeBox } from "@openclaw/normalization-core/json-schema";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
// Compiles plugin manifest schemas for validation without runtime loading.
import { Format } from "typebox/format";
import { Compile, type Validator as TypeBoxValidator } from "typebox/schema";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  applyJsonSchemaDefaults,
  findJsonSchemaShapeError,
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

// Transfer only defaults selected by the source; re-evaluating branches on resolved
// strings changes their meaning. Never restore a reference removed by runtime isolation.
function applyValidatedSourceDefaults(
  value: unknown,
  source: unknown,
  defaulted: unknown,
): unknown {
  if (source === undefined) {
    return value === undefined ? defaulted : value;
  }
  const target = asOptionalObjectRecord(value);
  const original = asOptionalObjectRecord(source);
  const hydrated = asOptionalObjectRecord(defaulted);
  if (target && original && hydrated) {
    for (const [key, entry] of Object.entries(hydrated)) {
      if (
        !isBlockedObjectKey(key) &&
        (Object.hasOwn(target, key) || !Object.hasOwn(original, key))
      ) {
        target[key] = applyValidatedSourceDefaults(target[key], original[key], entry);
      }
    }
  }
  return value;
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

function checkSchemaWithCurrentFormats(
  validate: TypeBoxValidator,
  value: unknown,
): TypeBoxValidationError[] | null {
  if (validate.Check(value)) {
    return null;
  }
  // The schema-only compiler returns [valid, errors], without loading value codecs.
  return validate.Errors(value)[1];
}

function isDefaultActivatedConditionalFailure(params: {
  schema: JsonSchemaValue;
  originalValue: unknown;
  defaultedValue: unknown;
}): boolean {
  const relaxedConditionalValidator = compileSchema(
    relaxConditionalRequiredKeywords(params.schema),
  );
  if (checkSchemaWithCurrentFormats(relaxedConditionalValidator, params.defaultedValue)) {
    return false;
  }
  const originalValidator = compileSchema(params.schema);
  return checkSchemaWithCurrentFormats(originalValidator, params.originalValue) === null;
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
  return `must have required property '${missingProperty}'`;
}

function formatAdditionalPropertiesMessage(error: TypeBoxValidationError): string | null {
  const additionalProperties = resolveAdditionalProperties(error);
  if (additionalProperties.length === 0) {
    return null;
  }
  const quoted = additionalProperties.map((entry) => `"${entry}"`).join(", ");
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
 * Validate a value against a schema supplied by a plugin manifest.
 * Manifest schemas are third-party input, so every failure mode is a validation
 * result: a structurally invalid schema, and a traversal that exhausts the stack
 * on a deeply nested one. validateJsonSchemaValue keeps throwing for repo-owned
 * schemas, where a malformed one is a programming error and must stay loud.
 */
export function validateManifestSchemaValue(
  params: Parameters<typeof validateJsonSchemaValue>[0],
): ReturnType<typeof validateJsonSchemaValue> {
  try {
    return validateJsonSchemaValue(params);
  } catch (error) {
    // The thrown text can embed raw manifest content (TypeBox echoes a bad regex
    // pattern), and callers log it, so it is sanitized like every other error path.
    const text = sanitizeTerminalText(error instanceof Error ? error.message : String(error));
    return { ok: false, errors: [{ path: "<root>", message: text, text }] };
  }
}

/**
 * Validate a plugin-owned value against a JSON Schema, optionally hydrating schema defaults.
 * The cache key is caller-owned so repeated plugin/schema validations can reuse compiled TypeBox validators.
 */
export function validateJsonSchemaValue(params: {
  schema: JsonSchemaValue;
  cacheKey: string;
  value: unknown;
  /** Persisted input paired with this runtime value, before secret resolution. */
  sourceValue?: unknown;
  applyDefaults?: boolean;
  cache?: boolean;
}): { ok: true; value: unknown } | { ok: false; errors: JsonSchemaValidationError[] } {
  const schemaError = findJsonSchemaShapeError(params.schema);
  if (schemaError) {
    throw new Error(sanitizeTerminalText(`invalid schema: ${schemaError}`));
  }

  const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
  let cached = params.cache === false ? undefined : schemaCache.get(cacheKey);
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
    if (params.cache !== false) {
      schemaCache.set(cacheKey, cached);
    }
  } else if (cached.schema !== params.schema) {
    cached.schema = params.schema;
  }

  return withPluginFormatSemantics(() => {
    const originalValue = params.sourceValue === undefined ? params.value : params.sourceValue;
    const value =
      params.applyDefaults && cached.hasDefaults
        ? applyJsonSchemaDefaults(params.schema, structuredClone(originalValue))
        : originalValue;
    const errors = checkSchemaWithCurrentFormats(cached.validate, value);
    // Defaults may activate a required-only conditional failure in otherwise valid source.
    if (
      errors &&
      !(
        params.applyDefaults &&
        value !== originalValue &&
        isDefaultActivatedConditionalFailure({
          schema: params.schema,
          originalValue,
          defaultedValue: value,
        })
      )
    ) {
      return { ok: false, errors: formatValidationErrors(errors) };
    }
    if (originalValue === params.value) {
      return { ok: true, value };
    }
    return {
      ok: true,
      value:
        value === originalValue
          ? params.value
          : applyValidatedSourceDefaults(structuredClone(params.value), originalValue, value),
    };
  });
}
