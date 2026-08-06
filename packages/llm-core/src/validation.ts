// LLM Core module implements validation behavior.
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import type { Tool, ToolCall } from "./types.js";

const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

/** Maximum string length accepted for schema-gated JSON coercion. */
const MAX_JSON_COERCE_LENGTH = 64 * 1024;

interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  items?: JsonSchemaObject | JsonSchemaObject[];
  additionalProperties?: boolean | JsonSchemaObject;
  allOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return isRecord(value);
}

function getSchemaTypes(schema: JsonSchemaObject): string[] {
  if (typeof schema.type === "string") {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter((type): type is string => typeof type === "string");
  }
  return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value) && !Array.isArray(value);
    default:
      return false;
  }
}

function isValidatorSchema(value: unknown): value is Tool["parameters"] {
  return isRecord(value);
}

const JSON_NUMBER_TOKEN_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/iu;

function parseJsonNumberString(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed || !JSON_NUMBER_TOKEN_RE.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonIntegerString(value: string): number | undefined {
  const parsed = parseJsonNumberString(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined;
}

function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
  if (!isValidatorSchema(schema)) {
    return undefined;
  }
  try {
    return getValidator(schema);
  } catch {
    return undefined;
  }
}

function coercePrimitiveByType(value: unknown, type: string): unknown {
  switch (type) {
    case "number": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = parseJsonNumberString(value);
        if (parsed !== undefined) {
          return parsed;
        }
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "integer": {
      if (value === null) {
        return 0;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = parseJsonIntegerString(value);
        if (parsed !== undefined) {
          return parsed;
        }
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      return value;
    }
    case "boolean": {
      if (value === null) {
        return false;
      }
      if (typeof value === "string") {
        if (value === "true") {
          return true;
        }
        if (value === "false") {
          return false;
        }
      }
      if (typeof value === "number") {
        if (value === 1) {
          return true;
        }
        if (value === 0) {
          return false;
        }
      }
      return value;
    }
    case "string": {
      if (value === null) {
        return "";
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return value;
    }
    case "array": {
      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= MAX_JSON_COERCE_LENGTH
      ) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // Not valid JSON; leave as-is for the validator to reject.
        }
      }
      return value;
    }
    case "object": {
      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= MAX_JSON_COERCE_LENGTH
      ) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
          }
        } catch {
          // Not valid JSON; leave as-is for the validator to reject.
        }
      }
      return value;
    }
    case "null": {
      if (value === "" || value === 0 || value === false) {
        return null;
      }
      return value;
    }
    default:
      return value;
  }
}

function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
  const properties = schema.properties;
  const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        value[key] = coerceWithJsonSchema(value[key], propertySchema);
      }
    }
  }

  if (schema.additionalProperties && isJsonSchemaObject(schema.additionalProperties)) {
    for (const [key, propertyValue] of Object.entries(value)) {
      if (!definedKeys.has(key)) {
        value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
      }
    }
  }
}

function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
  if (Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const itemSchema = schema.items[index];
      if (itemSchema) {
        value[index] = coerceWithJsonSchema(value[index], itemSchema);
      }
    }
    return;
  }

  if (isJsonSchemaObject(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = coerceWithJsonSchema(value[index], schema.items);
    }
  }
}

function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
  // When value is null, check if any union member accepts null directly
  // (type: "null") before falling through to coercion.  Without this check,
  // anyOf [{type: "string"}, {type: "null"}] coerces null → "" via the
  // string branch and never reaches the null branch.
  if (value === null) {
    for (const schema of schemas) {
      const types = getSchemaTypes(schema);
      if (types.includes("null")) {
        const validator = getSubSchemaValidator(schema);
        if (!validator || validator.Check(value)) {
          return value;
        }
      }
    }
  }
  for (const schema of schemas) {
    const candidate = structuredClone(value);
    const coerced = coerceWithJsonSchema(candidate, schema);
    const validator = getSubSchemaValidator(schema);
    if (validator?.Check(coerced)) {
      return coerced;
    }
  }
  return value;
}

function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
  let nextValue = value;

  if (Array.isArray(schema.allOf)) {
    for (const nested of schema.allOf) {
      nextValue = coerceWithJsonSchema(nextValue, nested);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
  }

  if (Array.isArray(schema.oneOf)) {
    nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
  }

  const schemaTypes = getSchemaTypes(schema);
  const matchesUnionMember =
    schemaTypes.length > 1 &&
    schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
  if (schemaTypes.length > 0 && !matchesUnionMember) {
    for (const schemaType of schemaTypes) {
      const candidate = coercePrimitiveByType(nextValue, schemaType);
      if (candidate !== nextValue) {
        nextValue = candidate;
        break;
      }
    }
  }

  if (schemaTypes.includes("object") && isRecord(nextValue) && !Array.isArray(nextValue)) {
    applySchemaObjectCoercion(nextValue, schema);
  }

  if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
    applySchemaArrayCoercion(nextValue, schema);
  }

  return nextValue;
}

function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
  const key = schema as object;
  const cached = validatorCache.get(key);
  if (cached) {
    return cached;
  }
  const validator = Compile(schema);
  validatorCache.set(key, validator);
  return validator;
}

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperty = (error.params as { requiredProperties?: string[] })
      .requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

/** Finds the target tool and validates/coerces a model-emitted tool call. */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): unknown {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) {
    throw new Error(`Tool "${toolCall.name}" not found`);
  }
  return validateToolArguments(tool, toolCall);
}

/** Validates tool arguments against TypeBox or plain JSON-schema parameters. */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): unknown {
  const args = structuredClone(toolCall.arguments);
  const validator = getValidator(tool.parameters);
  validator.Convert(args);

  if (isJsonSchemaObject(tool.parameters)) {
    // TypeBox conversion is intentionally conservative for plain JSON schemas;
    // mirror the provider-facing coercions so model-emitted string numbers validate.
    const coerced = coerceWithJsonSchema(args, tool.parameters);
    if (coerced !== args) {
      if (isRecord(args) && isRecord(coerced)) {
        for (const key of Object.keys(args)) {
          delete args[key];
        }
        Object.assign(args, coerced);
      } else {
        return validator.Check(coerced) ? coerced : args;
      }
    }
  }

  if (validator.Check(args)) {
    return args;
  }

  const errors =
    validator
      .Errors(args)
      .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
      .join("\n") || "Unknown validation error";

  throw new Error(
    `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
  );
}
