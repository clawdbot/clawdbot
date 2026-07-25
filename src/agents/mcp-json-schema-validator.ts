import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import { Compile } from "typebox/compile";
import { toErrorObject } from "../infra/errors.js";
import {
  findJsonSchemaShapeError,
  normalizeJsonSchemaForTypeBox,
} from "../shared/json-schema-defaults.js";

const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";

function isDraft202012Schema(schema: JsonSchemaType): boolean {
  return (schema as { $schema?: unknown }).$schema === DRAFT_2020_12_SCHEMA;
}

function formatTypeBoxErrors(errors: Array<{ instancePath?: string; message?: string }>): string {
  return (
    errors
      .map((error) => {
        const message = error.message?.trim() || "schema validation failed";
        return error.instancePath ? `${error.instancePath} ${message}` : message;
      })
      .join(", ") || "schema validation failed"
  );
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const schemaValueKeywords = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const schemaArrayKeywords = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

function stripSchemaMapFormats(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, stripJsonSchemaFormats(entry)]),
  );
}

function expandJsonSchemaTypeArray(schema: Record<string, unknown>): Record<string, unknown> {
  const { type, ...rest } = schema;
  if (!Array.isArray(type)) {
    return schema;
  }
  return {
    anyOf: type.map((entry) => Object.assign({}, rest, { type: entry })),
  };
}

function stripJsonSchemaFormats(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripJsonSchemaFormats(entry));
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const normalizedSchema = expandJsonSchemaTypeArray(schema as Record<string, unknown>);
  return Object.fromEntries(
    Object.entries(normalizedSchema)
      .filter(([key]) => key !== "format")
      .map(([key, value]) => {
        if (schemaMapKeywords.has(key)) {
          return [key, stripSchemaMapFormats(value)];
        }
        if (key === "dependencies") {
          return [key, stripSchemaMapFormats(value)];
        }
        if (schemaValueKeywords.has(key) || schemaArrayKeywords.has(key)) {
          return [key, stripJsonSchemaFormats(value)];
        }
        return [key, value];
      }),
  );
}

/** MCP SDK validator with draft-2020-12 support for external tool schemas. */
export function createMcpJsonSchemaValidator(): jsonSchemaValidator {
  const defaultValidator = new AjvJsonSchemaValidator();

  return {
    getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
      if (!isDraft202012Schema(schema)) {
        return defaultValidator.getValidator<T>(schema);
      }
      let validator: ReturnType<typeof Compile>;
      try {
        const schemaError = findJsonSchemaShapeError(schema as never);
        if (schemaError) {
          throw new Error(schemaError);
        }
        validator = Compile(
          normalizeJsonSchemaForTypeBox(stripJsonSchemaFormats(schema) as never) as never,
        );
      } catch (error) {
        const setupError = toErrorObject(error, "schema setup failed");
        throw new Error(`Invalid MCP draft-2020-12 JSON Schema: ${setupError.message}`, {
          cause: error,
        });
      }
      return (input: unknown) => {
        const valid = validator.Check(input);
        if (valid) {
          return { valid: true, data: input as T, errorMessage: undefined };
        }
        return {
          valid: false,
          data: undefined,
          errorMessage: formatTypeBoxErrors([...validator.Errors(input)]),
        };
      };
    },
  };
}
