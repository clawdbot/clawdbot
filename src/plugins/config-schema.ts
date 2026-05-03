import { z, type ZodTypeAny } from "zod";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type { PluginConfigUiHint } from "./manifest-types.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type { OpenClawPluginConfigSchema } from "./types.js";

type Issue = { path: Array<string | number>; message: string };

type SafeParseResult =
  | { success: true; data?: unknown }
  | { success: false; error: { issues: Issue[] } };

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type BuildPluginConfigSchemaOptions = {
  uiHints?: Record<string, PluginConfigUiHint>;
  safeParse?: OpenClawPluginConfigSchema["safeParse"];
};

type BuildJsonPluginConfigSchemaOptions = {
  cacheKey?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
  safeParse?: OpenClawPluginConfigSchema["safeParse"];
};

function error(message: string): SafeParseResult {
  return { success: false, error: { issues: [{ path: [], message }] } };
}

function cloneIssue(issue: z.ZodIssue): Issue {
  return {
    path: issue.path.filter((segment): segment is string | number => {
      const kind = typeof segment;
      return kind === "string" || kind === "number";
    }),
    message: issue.message,
  };
}

function safeParseRuntimeSchema(schema: ZodTypeAny, value: unknown): SafeParseResult {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }
  return {
    success: false,
    error: { issues: result.error.issues.map((issue) => cloneIssue(issue)) },
  };
}

function normalizeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeJsonSchema(item));
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const record = { ...(schema as Record<string, unknown>) };
  delete record.$schema;

  for (const [key, value] of Object.entries(record)) {
    record[key] = normalizeJsonSchema(value);
  }

  const propertyNames = record.propertyNames;
  if (
    propertyNames &&
    typeof propertyNames === "object" &&
    !Array.isArray(propertyNames) &&
    (propertyNames as Record<string, unknown>).type === "string"
  ) {
    delete record.propertyNames;
  }

  if (Array.isArray(record.required) && record.required.length === 0) {
    delete record.required;
  }

  return record;
}

function toIssuePath(path: string): Array<string | number> {
  if (!path || path === "<root>") {
    return [];
  }
  return path.split(".").map((segment) => {
    const index = Number(segment);
    return Number.isInteger(index) && String(index) === segment ? index : segment;
  });
}

function safeParseJsonSchema(
  schema: JsonSchemaObject,
  cacheKey: string,
  value: unknown,
): SafeParseResult {
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value,
    applyDefaults: true,
  });
  if (result.ok) {
    return { success: true, data: result.value };
  }
  return {
    success: false,
    error: {
      issues: result.errors.map((issue) => ({
        path: toIssuePath(issue.path),
        message: issue.message,
      })),
    },
  };
}

export function buildJsonPluginConfigSchema(
  schema: JsonSchemaObject,
  options?: BuildJsonPluginConfigSchemaOptions,
): OpenClawPluginConfigSchema {
  const safeParse =
    options?.safeParse ??
    ((value: unknown) =>
      safeParseJsonSchema(schema, options?.cacheKey ?? "plugin-config-schema:json", value));
  return {
    safeParse,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    jsonSchema: normalizeJsonSchema(schema) as JsonSchemaObject,
  };
}

export function buildPluginConfigSchema(
  schema: ZodTypeAny,
  options?: BuildPluginConfigSchemaOptions,
): OpenClawPluginConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  const safeParse = options?.safeParse ?? ((value) => safeParseRuntimeSchema(schema, value));
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      safeParse,
      ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
      jsonSchema: normalizeJsonSchema(
        schemaWithJson.toJSONSchema({
          target: "draft-07",
          io: "input",
          unrepresentable: "any",
        }),
      ) as JsonSchemaObject,
    };
  }

  return {
    safeParse,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    jsonSchema: {
      type: "object",
      additionalProperties: true,
    },
  };
}

export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown): SafeParseResult {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value as Record<string, unknown>).length > 0) {
        return error("config must be empty");
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}
