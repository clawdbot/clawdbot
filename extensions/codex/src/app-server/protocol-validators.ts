/**
 * Runtime validators for Codex app-server protocol payloads, including schema
 * normalization for generated JSON Schema before TypeBox compilation.
 */
import { Compile, type Validator as TypeBoxValidator } from "typebox/compile";
import dynamicToolCallParamsSchema from "./protocol-generated/json/DynamicToolCallParams.json" with { type: "json" };
import errorNotificationSchema from "./protocol-generated/json/v2/ErrorNotification.json" with { type: "json" };
import modelListResponseSchema from "./protocol-generated/json/v2/ModelListResponse.json" with { type: "json" };
import threadResumeResponseSchema from "./protocol-generated/json/v2/ThreadResumeResponse.json" with { type: "json" };
import threadStartResponseSchema from "./protocol-generated/json/v2/ThreadStartResponse.json" with { type: "json" };
import turnCompletedNotificationSchema from "./protocol-generated/json/v2/TurnCompletedNotification.json" with { type: "json" };
import turnStartResponseSchema from "./protocol-generated/json/v2/TurnStartResponse.json" with { type: "json" };
import type {
  CodexDynamicToolCallParams,
  CodexErrorNotification,
  CodexModelListResponse,
  CodexThreadForkResponse,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurn,
  CodexTurnCompletedNotification,
  CodexTurnStartResponse,
} from "./protocol.js";

type ValidationError = {
  instancePath?: string;
  message?: string;
};

type CodexValidator<T> = {
  check: (value: unknown) => value is T;
  errors: (value: unknown) => ValidationError[];
};

function compileCodexSchema<T>(schema: unknown): CodexValidator<T> {
  const validator = Compile(normalizeJsonSchemaNode(schema) as never) as TypeBoxValidator;
  return {
    check: (value): value is T => validator.Check(value),
    errors: (value) => [...validator.Errors(value)] as ValidationError[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function schemaTypeIncludes(schema: Record<string, unknown>, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function normalizeSchemaMap(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeJsonSchemaNode(entry)]),
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

function normalizeJsonSchemaNode(schema: unknown): unknown {
  // Generated schemas can use JSON Schema type arrays; TypeBox validators need
  // equivalent anyOf branches to preserve nullable/union semantics.
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeJsonSchemaNode(entry));
  }
  if (!isRecord(schema)) {
    return schema;
  }
  const normalizedSchema = expandJsonSchemaTypeArray(schema);
  return Object.fromEntries(
    Object.entries(normalizedSchema).map(([key, value]) => {
      if (schemaMapKeywords.has(key)) {
        return [key, normalizeSchemaMap(value)];
      }
      if (schemaValueKeywords.has(key) || schemaArrayKeywords.has(key)) {
        return [key, normalizeJsonSchemaNode(value)];
      }
      return [key, value];
    }),
  );
}

function readDefault(schema: unknown): unknown {
  if (!isRecord(schema) || !Object.hasOwn(schema, "default")) {
    return undefined;
  }
  return structuredClone(schema.default);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let current = root;
  for (const segment of ref.slice(2).split("/").map(decodePointerSegment)) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function applySchemaDefaults(
  schema: unknown,
  value: unknown,
  root = schema,
  resolvingRefs = new Set<string>(),
): unknown {
  // Codex omits some fields that generated schemas default. Apply those defaults
  // before validation so callers get stable normalized protocol shapes.
  if (value === undefined) {
    const defaultValue = readDefault(schema);
    if (defaultValue !== undefined) {
      return defaultValue;
    }
  }
  if (!isRecord(schema)) {
    return value;
  }
  let nextValue = value;
  if (typeof schema.$ref === "string" && !resolvingRefs.has(schema.$ref)) {
    const target = resolveLocalRef(root, schema.$ref);
    if (target !== undefined) {
      resolvingRefs.add(schema.$ref);
      nextValue = applySchemaDefaults(target, nextValue, root, resolvingRefs);
      resolvingRefs.delete(schema.$ref);
    }
  }
  for (const key of ["allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        nextValue = applySchemaDefaults(branch, nextValue, root, resolvingRefs);
      }
    }
  }
  if (schemaTypeIncludes(schema, "object") && isRecord(nextValue) && isRecord(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      const currentValue = nextValue[key];
      const defaultedValue = applySchemaDefaults(propertySchema, currentValue, root, resolvingRefs);
      if (defaultedValue !== undefined && defaultedValue !== currentValue) {
        nextValue[key] = defaultedValue;
      }
    }
    if (isRecord(schema.additionalProperties)) {
      for (const key of Object.keys(nextValue)) {
        if (Object.hasOwn(schema.properties, key)) {
          continue;
        }
        nextValue[key] = applySchemaDefaults(
          schema.additionalProperties,
          nextValue[key],
          root,
          resolvingRefs,
        );
      }
    }
  }
  if (schemaTypeIncludes(schema, "array") && Array.isArray(nextValue) && isRecord(schema.items)) {
    return nextValue.map((entry) => applySchemaDefaults(schema.items, entry, root, resolvingRefs));
  }
  return nextValue;
}

function normalizeWithDefaults(schema: unknown, value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  return applySchemaDefaults(schema, structuredClone(value));
}

const validateDynamicToolCallParams = compileCodexSchema<CodexDynamicToolCallParams>(
  dynamicToolCallParamsSchema,
);
const validateErrorNotification =
  compileCodexSchema<CodexErrorNotification>(errorNotificationSchema);
const validateModelListResponse =
  compileCodexSchema<CodexModelListResponse>(modelListResponseSchema);
const validateThreadResumeResponse = compileCodexSchema<CodexThreadResumeResponse>(
  threadResumeResponseSchema,
);
const validateThreadStartResponse =
  compileCodexSchema<CodexThreadStartResponse>(threadStartResponseSchema);
const validateTurnCompletedNotification = compileCodexSchema<CodexTurnCompletedNotification>(
  turnCompletedNotificationSchema,
);
const validateTurnStartResponse =
  compileCodexSchema<CodexTurnStartResponse>(turnStartResponseSchema);

/** Asserts and normalizes a Codex thread/start response. */
export function assertCodexThreadStartResponse(value: unknown): CodexThreadStartResponse {
  const normalized = normalizeWithDefaults(
    threadStartResponseSchema,
    normalizeThreadResponse(value),
  );
  return assertCodexShape(validateThreadStartResponse, normalized, "thread/start response");
}

/** Asserts and normalizes a Codex thread/fork response. */
export function assertCodexThreadForkResponse(value: unknown): CodexThreadForkResponse {
  const normalized = normalizeWithDefaults(
    threadStartResponseSchema,
    normalizeThreadResponse(value),
  );
  return assertCodexShape(validateThreadStartResponse, normalized, "thread/fork response");
}

/** Asserts and normalizes a Codex thread/resume response. */
export function assertCodexThreadResumeResponse(value: unknown): CodexThreadResumeResponse {
  const normalized = normalizeWithDefaults(
    threadResumeResponseSchema,
    normalizeThreadResponse(value),
  );
  return assertCodexShape(validateThreadResumeResponse, normalized, "thread/resume response");
}

/** Asserts and normalizes a Codex turn/start response. */
export function assertCodexTurnStartResponse(value: unknown): CodexTurnStartResponse {
  const normalized = normalizeWithDefaults(
    turnStartResponseSchema,
    normalizeTurnStartResponse(value),
  );
  return assertCodexShape(validateTurnStartResponse, normalized, "turn/start response");
}

/** Reads Codex dynamic-tool call params, returning undefined for invalid payloads. */
export function readCodexDynamicToolCallParams(
  value: unknown,
): CodexDynamicToolCallParams | undefined {
  return readCodexShape(
    validateDynamicToolCallParams,
    normalizeWithDefaults(dynamicToolCallParamsSchema, value),
  );
}

/** Reads a Codex error notification payload if it matches the protocol schema. */
export function readCodexErrorNotification(value: unknown): CodexErrorNotification | undefined {
  return readCodexShape(
    validateErrorNotification,
    normalizeWithDefaults(errorNotificationSchema, value),
  );
}

/** Reads a Codex model/list response if it matches the protocol schema. */
export function readCodexModelListResponse(value: unknown): CodexModelListResponse | undefined {
  return readCodexShape(
    validateModelListResponse,
    normalizeWithDefaults(modelListResponseSchema, value),
  );
}

/** Reads and normalizes a Codex turn object. */
export function readCodexTurn(value: unknown): CodexTurn | undefined {
  const response = readCodexShape(
    validateTurnStartResponse,
    normalizeWithDefaults(turnStartResponseSchema, { turn: normalizeTurn(value) }),
  );
  return response?.turn;
}

/** Reads a Codex turn/completed notification payload if it matches the protocol schema. */
export function readCodexTurnCompletedNotification(
  value: unknown,
): CodexTurnCompletedNotification | undefined {
  return readCodexShape(
    validateTurnCompletedNotification,
    normalizeWithDefaults(
      turnCompletedNotificationSchema,
      normalizeTurnCompletedNotification(value),
    ),
  );
}

function assertCodexShape<T>(validate: CodexValidator<T>, value: unknown, label: string): T {
  if (validate.check(value)) {
    return value;
  }
  throw new Error(`Invalid Codex app-server ${label}: ${formatValidationErrors(validate, value)}`);
}

function readCodexShape<T>(validate: CodexValidator<T>, value: unknown): T | undefined {
  return validate.check(value) ? value : undefined;
}

function normalizeTurn(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return {
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...value,
    items: Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items.map(normalizeThreadItem)
      : [],
  };
}

function normalizeThreadItem(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const item = value as { type?: unknown };
  switch (item.type) {
    case "agentMessage":
      return { phase: null, memoryCitation: null, ...value };
    case "plan":
      return { text: "", ...value };
    case "reasoning":
      return { summary: [], content: [], ...value };
    case "dynamicToolCall":
      return {
        namespace: null,
        arguments: null,
        status: "completed",
        contentItems: null,
        success: null,
        durationMs: null,
        ...value,
      };
    default:
      return value;
  }
}

function normalizeThreadResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("thread" in value)) {
    return value;
  }
  const thread = (value as { thread?: unknown }).thread;
  if (thread && typeof thread === "object" && !Array.isArray(thread)) {
    const t = thread as { id?: string; sessionId?: string };
    if (typeof t.id === "string" && typeof t.sessionId !== "string") {
      return { ...value, thread: { ...thread, sessionId: t.id } };
    }
    if (typeof t.sessionId === "string" && typeof t.id !== "string") {
      return { ...value, thread: { ...thread, id: t.sessionId } };
    }
  }
  return value;
}

function normalizeTurnStartResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("turn" in value)) {
    return value;
  }
  return {
    ...value,
    turn: normalizeTurn((value as { turn?: unknown }).turn),
  };
}

function normalizeTurnCompletedNotification(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("turn" in value)) {
    return value;
  }
  return {
    ...value,
    turn: normalizeTurn((value as { turn?: unknown }).turn),
  };
}

function formatValidationErrors(validate: CodexValidator<unknown>, value: unknown): string {
  const errors = validate.errors(value);
  if (!errors || errors.length === 0) {
    return "schema validation failed";
  }
  return errors
    .map((error) => {
      const message = error.message?.trim() || "schema validation failed";
      return error.instancePath ? `${error.instancePath} ${message}` : message;
    })
    .join("; ");
}
