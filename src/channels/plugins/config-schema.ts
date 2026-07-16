/**
 * Channel config schema helpers.
 *
 * Builds common zod/JSON schema shapes and parses runtime config issues for channel plugins.
 */
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { DmPolicySchema } from "../../config/zod-schema.core.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
import { parseConfigPathArrayIndex } from "../../shared/path-array-index.js";
import type {
  ChannelConfigRuntimeIssue,
  ChannelConfigRuntimeParseResult,
  ChannelConfigSchema,
  ChannelConfigUiHint,
} from "./types.config.js";

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type ExtendableZodObject = ZodTypeAny & {
  extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};

/** Shared allowlist entry shape for channel sender/user ids. */
const AllowFromEntrySchema = z.union([z.string(), z.number()]);
/** Optional allowlist array used by channel config schema builders. */
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();

/** Build the common nested DM config block used by channel account schemas. */
export function buildNestedDmConfigSchema(extraShape?: ZodRawShape) {
  const baseShape = {
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: AllowFromListSchema,
  };
  return z.object(extraShape ? { ...baseShape, ...extraShape } : baseShape).optional();
}

/** Add `accounts` catchall and `defaultAccount` fields to a channel account schema. */
export function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(
  accountSchema: T,
): T {
  return accountSchema.extend({
    accounts: z.object({}).catchall(accountSchema).optional(),
    defaultAccount: z.string().optional(),
  }) as T;
}

type BuildChannelConfigSchemaOptions = {
  uiHints?: Record<string, ChannelConfigUiHint>;
  /** Select input mode when transforms must expose accepted config values to editors. */
  jsonSchemaMode?: "input" | "output";
};

type BuildJsonChannelConfigSchemaOptions = {
  cacheKey?: string;
  uiHints?: Record<string, ChannelConfigUiHint>;
  runtime?: ChannelConfigSchema["runtime"];
};

function cloneRuntimeIssue(issue: unknown): ChannelConfigRuntimeIssue {
  const record = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
  const path = Array.isArray(record.path)
    ? record.path.filter((segment): segment is string | number => {
        const kind = typeof segment;
        return kind === "string" || kind === "number";
      })
    : undefined;
  return {
    ...record,
    ...(path ? { path } : {}),
  };
}

function safeParseRuntimeSchema(
  schema: ZodTypeAny,
  value: unknown,
): ChannelConfigRuntimeParseResult {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      success: true,
      data: result.data,
    };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => cloneRuntimeIssue(issue)),
  };
}

function toIssuePath(path: string): Array<string | number> {
  if (!path || path === "<root>") {
    return [];
  }
  return path.split(".").map((segment) => {
    return parseConfigPathArrayIndex(segment) ?? segment;
  });
}

function safeParseJsonSchema(
  schema: JsonSchemaObject,
  cacheKey: string,
  value: unknown,
): ChannelConfigRuntimeParseResult {
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
    issues: result.errors.map((issue) => ({
      path: toIssuePath(issue.path),
      message: issue.message,
    })),
  };
}

/** Build a channel config schema from JSON Schema with runtime validation/default support. */
export function buildJsonChannelConfigSchema(
  schema: JsonSchemaObject,
  options?: BuildJsonChannelConfigSchemaOptions,
): ChannelConfigSchema {
  return {
    schema,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: options?.runtime ?? {
      safeParse: (value) =>
        safeParseJsonSchema(schema, options?.cacheKey ?? "channel-config-schema:json", value),
    },
  };
}

/** Build a channel config schema from Zod, exporting JSON Schema when available. */
export function buildChannelConfigSchema(
  schema: ZodTypeAny,
  options?: BuildChannelConfigSchemaOptions,
): ChannelConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: schemaWithJson.toJSONSchema({
        target: "draft-07",
        ...(options?.jsonSchemaMode ? { io: options.jsonSchemaMode } : {}),
        unrepresentable: "any",
      }) as JsonSchemaObject,
      ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
      runtime: {
        safeParse: (value) => safeParseRuntimeSchema(schema, value),
      },
    };
  }

  // Compatibility fallback for plugins built against Zod v3 schemas,
  // where `.toJSONSchema()` is unavailable.
  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: {
      safeParse: (value) => safeParseRuntimeSchema(schema, value),
    },
  };
}

/** Return a channel config schema for channels that intentionally accept no config keys. */
export function emptyChannelConfigSchema(): ChannelConfigSchema {
  return {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    runtime: {
      safeParse(value) {
        if (value === undefined) {
          return { success: true, data: undefined };
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return {
            success: false,
            issues: [{ path: [], message: "expected config object" }],
          };
        }
        if (Object.keys(value as Record<string, unknown>).length > 0) {
          return {
            success: false,
            issues: [{ path: [], message: "config must be empty" }],
          };
        }
        return { success: true, data: value };
      },
    },
  };
}
