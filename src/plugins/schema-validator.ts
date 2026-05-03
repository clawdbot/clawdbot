import { createRequire } from "node:module";
import type { ErrorObject, ValidateFunction } from "ajv";
import { appendAllowedValuesHint, summarizeAllowedValues } from "../config/allowed-values.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { PluginLruCache } from "./plugin-cache-primitives.js";

const require = createRequire(import.meta.url);
type AjvLike = {
  addFormat: (
    name: string,
    format:
      | RegExp
      | {
          type?: string;
          validate: (value: string) => boolean;
        },
  ) => AjvLike;
  compile: (schema: JsonSchemaObject) => ValidateFunction;
};
const ajvSingletons = new Map<"default" | "defaults", AjvLike>();

function getAjv(mode: "default" | "defaults"): AjvLike {
  const cached = ajvSingletons.get(mode);
  if (cached) {
    return cached;
  }
  const ajvModule = require("ajv") as { default?: new (opts?: object) => AjvLike };
  const AjvCtor =
    typeof ajvModule.default === "function"
      ? ajvModule.default
      : (ajvModule as unknown as new (opts?: object) => AjvLike);
  const instance = new AjvCtor({
    allErrors: true,
    strict: false,
    removeAdditional: false,
    ...(mode === "defaults" ? { useDefaults: true } : {}),
  });
  instance.addFormat("uri", {
    type: "string",
    validate: (value: string) => {
      // Accept absolute URIs so generated config schemas can keep JSON Schema
      // `format: "uri"` without noisy AJV warnings during validation/build.
      return URL.canParse(value);
    },
  });
  ajvSingletons.set(mode, instance);
  return instance;
}

type CachedValidator = {
  hasDefaults: boolean;
  validate: ValidateFunction;
  schema: JsonSchemaObject;
  schemaFingerprint: string;
};

const schemaCache = new PluginLruCache<CachedValidator>(512);

function fingerprintSchema(schema: JsonSchemaObject): string {
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
  if (Object.prototype.hasOwnProperty.call(record, "default")) {
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

export type JsonSchemaValidationError = {
  path: string;
  message: string;
  text: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

function normalizeAjvPath(instancePath: string | undefined): string {
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

function resolveMissingProperty(error: ErrorObject): string | null {
  if (
    error.keyword !== "required" &&
    error.keyword !== "dependentRequired" &&
    error.keyword !== "dependencies"
  ) {
    return null;
  }
  const missingProperty = (error.params as { missingProperty?: unknown }).missingProperty;
  return typeof missingProperty === "string" && missingProperty.trim() ? missingProperty : null;
}

function resolveAjvErrorPath(error: ErrorObject): string {
  const basePath = normalizeAjvPath(error.instancePath);
  const missingProperty = resolveMissingProperty(error);
  if (!missingProperty) {
    return basePath;
  }
  return appendPathSegment(basePath, missingProperty);
}

function extractAllowedValues(error: ErrorObject): unknown[] | null {
  if (error.keyword === "enum") {
    const allowedValues = (error.params as { allowedValues?: unknown }).allowedValues;
    return Array.isArray(allowedValues) ? allowedValues : null;
  }

  if (error.keyword === "const") {
    const params = error.params as { allowedValue?: unknown };
    if (!Object.prototype.hasOwnProperty.call(params, "allowedValue")) {
      return null;
    }
    return [params.allowedValue];
  }

  return null;
}

function getAjvAllowedValuesSummary(error: ErrorObject): ReturnType<typeof summarizeAllowedValues> {
  const allowedValues = extractAllowedValues(error);
  if (!allowedValues) {
    return null;
  }
  return summarizeAllowedValues(allowedValues);
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): JsonSchemaValidationError[] {
  if (!errors || errors.length === 0) {
    return [{ path: "<root>", message: "invalid config", text: "<root>: invalid config" }];
  }
  return errors.map((error) => {
    const path = resolveAjvErrorPath(error);
    const baseMessage = error.message ?? "invalid";
    const allowedValuesSummary = getAjvAllowedValuesSummary(error);
    const message = allowedValuesSummary
      ? appendAllowedValuesHint(baseMessage, allowedValuesSummary)
      : baseMessage;
    const safePath = sanitizeTerminalText(path);
    const safeMessage = sanitizeTerminalText(message);
    return {
      path,
      message,
      text: `${safePath}: ${safeMessage}`,
      ...(allowedValuesSummary
        ? {
            allowedValues: allowedValuesSummary.values,
            allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
          }
        : {}),
    };
  });
}

export function validateJsonSchemaValue(params: {
  schema: JsonSchemaObject;
  cacheKey: string;
  value: unknown;
  applyDefaults?: boolean;
}): { ok: true; value: unknown } | { ok: false; errors: JsonSchemaValidationError[] } {
  const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
  let cached = schemaCache.get(cacheKey);
  const schemaFingerprint =
    !cached || cached.schema !== params.schema ? fingerprintSchema(params.schema) : undefined;
  if (
    !cached ||
    (cached.schema !== params.schema && cached.schemaFingerprint !== schemaFingerprint)
  ) {
    const validate = getAjv(params.applyDefaults ? "defaults" : "default").compile(params.schema);
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
    params.applyDefaults && cached.hasDefaults ? cloneValidationValue(params.value) : params.value;
  const ok = cached.validate(value);
  if (ok) {
    return { ok: true, value };
  }
  return { ok: false, errors: formatAjvErrors(cached.validate.errors) };
}
