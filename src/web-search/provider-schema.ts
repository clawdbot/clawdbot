import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { WebSearchProviderModelSchema } from "./provider-model-schema.js";

// Provider artifacts become model-visible text, so both serialized size and
// compact/deep structures must stay below the repository context-budget boundary.
const MAX_PROVIDER_MODEL_SCHEMA_BYTES = 2_048;
const MAX_PROVIDER_MODEL_SCHEMA_DEPTH = 6;
const MAX_PROVIDER_MODEL_SCHEMA_NODES = 128;
const MAX_PROVIDER_MODEL_SCHEMA_ENTRIES = 32;
const MAX_PROVIDER_MODEL_SCHEMA_STRING_LENGTH = 256;
const MAX_PROVIDER_MODEL_SCHEMA_PARAMETERS = 8;
const MAX_PROVIDER_PARAMETER_NAME_LENGTH = 64;
const INVALID_SCHEMA_VALUE = Symbol("invalid provider model schema value");
const PROVIDER_PARAMETER_PATTERN = /^[a-z][a-z0-9_]*$/u;
const ALLOWED_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

type BoundedJsonValue =
  | null
  | boolean
  | number
  | string
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

type SchemaCloneState = {
  nodes: number;
};

function cloneBoundedSchemaValue(
  value: unknown,
  depth: number,
  state: SchemaCloneState,
): BoundedJsonValue | typeof INVALID_SCHEMA_VALUE {
  state.nodes += 1;
  if (state.nodes > MAX_PROVIDER_MODEL_SCHEMA_NODES || depth > MAX_PROVIDER_MODEL_SCHEMA_DEPTH) {
    return INVALID_SCHEMA_VALUE;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_SCHEMA_VALUE;
  }
  if (typeof value === "string") {
    return value.length <= MAX_PROVIDER_MODEL_SCHEMA_STRING_LENGTH ? value : INVALID_SCHEMA_VALUE;
  }
  if (typeof value !== "object") {
    return INVALID_SCHEMA_VALUE;
  }
  if (Array.isArray(value)) {
    try {
      if (value.length > MAX_PROVIDER_MODEL_SCHEMA_ENTRIES) {
        return INVALID_SCHEMA_VALUE;
      }
      const cloned: BoundedJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          return INVALID_SCHEMA_VALUE;
        }
        const entry = cloneBoundedSchemaValue(descriptor.value, depth + 1, state);
        if (entry === INVALID_SCHEMA_VALUE) {
          return INVALID_SCHEMA_VALUE;
        }
        cloned.push(entry);
      }
      return cloned;
    } catch {
      return INVALID_SCHEMA_VALUE;
    }
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return INVALID_SCHEMA_VALUE;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return INVALID_SCHEMA_VALUE;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_PROVIDER_MODEL_SCHEMA_ENTRIES) {
      return INVALID_SCHEMA_VALUE;
    }
    const cloned: { [key: string]: BoundedJsonValue } = Object.create(null);
    for (const key of keys) {
      if (key.length > MAX_PROVIDER_PARAMETER_NAME_LENGTH) {
        return INVALID_SCHEMA_VALUE;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        return INVALID_SCHEMA_VALUE;
      }
      const entry = cloneBoundedSchemaValue(descriptor.value, depth + 1, state);
      if (entry === INVALID_SCHEMA_VALUE) {
        return INVALID_SCHEMA_VALUE;
      }
      cloned[key] = entry;
    }
    return cloned;
  } catch {
    return INVALID_SCHEMA_VALUE;
  }
}

function isSchemaNode(value: unknown): boolean {
  if (typeof value === "boolean") {
    return true;
  }
  const schema = asOptionalRecord(value);
  if (!schema) {
    return false;
  }
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    switch (keyword) {
      case "type": {
        const types = Array.isArray(keywordValue) ? keywordValue : [keywordValue];
        if (
          types.length === 0 ||
          !types.every((entry) => typeof entry === "string" && ALLOWED_SCHEMA_TYPES.has(entry))
        ) {
          return false;
        }
        break;
      }
      case "title":
      case "description":
      case "pattern":
      case "format":
        if (typeof keywordValue !== "string") {
          return false;
        }
        break;
      case "minimum":
      case "maximum":
      case "exclusiveMinimum":
      case "exclusiveMaximum":
      case "multipleOf":
        if (typeof keywordValue !== "number" || !Number.isFinite(keywordValue)) {
          return false;
        }
        break;
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
      case "minProperties":
      case "maxProperties":
        if (
          typeof keywordValue !== "number" ||
          !Number.isInteger(keywordValue) ||
          keywordValue < 0
        ) {
          return false;
        }
        break;
      case "uniqueItems":
      case "nullable":
        if (typeof keywordValue !== "boolean") {
          return false;
        }
        break;
      case "enum":
      case "examples":
        if (!Array.isArray(keywordValue) || keywordValue.length === 0) {
          return false;
        }
        break;
      case "const":
      case "default":
        break;
      case "required":
        if (
          !Array.isArray(keywordValue) ||
          !keywordValue.every((entry) => typeof entry === "string") ||
          new Set(keywordValue).size !== keywordValue.length
        ) {
          return false;
        }
        break;
      case "properties": {
        const properties = asOptionalRecord(keywordValue);
        if (!properties || !Object.values(properties).every(isSchemaNode)) {
          return false;
        }
        break;
      }
      case "items":
        if (
          !(Array.isArray(keywordValue)
            ? keywordValue.length > 0 && keywordValue.every(isSchemaNode)
            : isSchemaNode(keywordValue))
        ) {
          return false;
        }
        break;
      case "additionalProperties":
      case "not":
        if (!isSchemaNode(keywordValue)) {
          return false;
        }
        break;
      case "anyOf":
      case "oneOf":
      case "allOf":
        if (
          !Array.isArray(keywordValue) ||
          keywordValue.length === 0 ||
          !keywordValue.every(isSchemaNode)
        ) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

function resolveBoundedProviderModelSchema(
  providerSchema: WebSearchProviderModelSchema,
): WebSearchProviderModelSchema | null {
  const cloned = cloneBoundedSchemaValue(providerSchema, 0, { nodes: 0 });
  if (cloned === INVALID_SCHEMA_VALUE) {
    return null;
  }
  const serialized = JSON.stringify(cloned);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_MODEL_SCHEMA_BYTES) {
    return null;
  }
  const modelSchema = asOptionalRecord(cloned);
  const parameters = asOptionalRecord(modelSchema?.parameters);
  const properties = asOptionalRecord(parameters?.properties);
  const providerParameters = modelSchema?.providerParameters;
  const parameterKeys = properties ? Object.keys(properties) : [];
  if (
    !modelSchema ||
    !Object.keys(modelSchema).every(
      (entry) => entry === "parameters" || entry === "providerParameters",
    ) ||
    parameters?.type !== "object" ||
    !properties ||
    !Array.isArray(providerParameters) ||
    providerParameters.length === 0 ||
    providerParameters.length > MAX_PROVIDER_MODEL_SCHEMA_PARAMETERS ||
    !providerParameters.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length <= MAX_PROVIDER_PARAMETER_NAME_LENGTH &&
        PROVIDER_PARAMETER_PATTERN.test(entry),
    ) ||
    new Set(providerParameters).size !== providerParameters.length ||
    parameterKeys.length !== providerParameters.length ||
    !parameterKeys.every((entry) => providerParameters.includes(entry)) ||
    !Object.values(properties).every(isSchemaNode) ||
    !Object.keys(parameters).every(
      (entry) => entry === "type" || entry === "properties" || entry === "required",
    )
  ) {
    return null;
  }
  const required = parameters.required;
  if (
    required !== undefined &&
    (!Array.isArray(required) ||
      !required.every((entry) => typeof entry === "string" && providerParameters.includes(entry)) ||
      new Set(required).size !== required.length)
  ) {
    return null;
  }
  return {
    parameters,
    providerParameters,
  };
}

function resolveSchemaProperty(schema: unknown, propertyName: string): unknown {
  const properties = asOptionalRecord(asOptionalRecord(schema)?.properties);
  if (!properties || !Object.hasOwn(properties, propertyName)) {
    return undefined;
  }
  return properties[propertyName];
}

/** Reports whether a provider tool schema explicitly declares a property. */
export function schemaDeclaresProperty(schema: unknown, propertyName: string): boolean {
  return resolveSchemaProperty(schema, propertyName) !== undefined;
}

function resolveRequiredProperties(schema: unknown): readonly string[] {
  const required = asOptionalRecord(schema)?.required;
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Projects provider-owned properties and their required status into a shared tool schema. */
export function projectProviderModelSchema(
  baseSchema: Record<string, unknown>,
  providerSchema: WebSearchProviderModelSchema | null,
): Record<string, unknown> {
  if (!providerSchema) {
    return baseSchema;
  }
  const boundedProviderSchema = resolveBoundedProviderModelSchema(providerSchema);
  if (!boundedProviderSchema) {
    return baseSchema;
  }
  const properties = { ...asOptionalRecord(baseSchema.properties) };
  const projectedRequired = new Set(resolveRequiredProperties(baseSchema));
  const providerRequired = new Set(resolveRequiredProperties(boundedProviderSchema.parameters));
  for (const parameter of boundedProviderSchema.providerParameters) {
    if (Object.hasOwn(properties, parameter)) {
      continue;
    }
    const propertySchema = resolveSchemaProperty(boundedProviderSchema.parameters, parameter);
    if (propertySchema === undefined) {
      continue;
    }
    properties[parameter] = propertySchema;
    if (providerRequired.has(parameter)) {
      projectedRequired.add(parameter);
    }
  }
  return {
    ...baseSchema,
    properties,
    required: [...projectedRequired],
  };
}
