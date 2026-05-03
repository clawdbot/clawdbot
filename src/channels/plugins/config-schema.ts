import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { DmPolicySchema } from "../../config/zod-schema.core.js";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
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

export const AllowFromEntrySchema = z.union([z.string(), z.number()]);
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();

export function buildNestedDmConfigSchema(extraShape?: ZodRawShape) {
  const baseShape = {
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    allowFrom: AllowFromListSchema,
  };
  return z.object(extraShape ? { ...baseShape, ...extraShape } : baseShape).optional();
}

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
    const index = Number(segment);
    return Number.isInteger(index) && String(index) === segment ? index : segment;
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

export function buildChannelConfigSchema(
  schema: ZodTypeAny,
  options?: BuildChannelConfigSchemaOptions,
): ChannelConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: schemaWithJson.toJSONSchema({
        target: "draft-07",
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
