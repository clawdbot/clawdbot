import { arrayItemSchema, arrayItemSchemaIndexes } from "./config-form.array-items.ts";
// Control UI view renders config form.analyze screen content.
import {
  objectAdditionalPropertiesSchema,
  objectPropertyKeys,
  objectPropertySchema,
  requiredPropertyKeys,
} from "./config-form.constraints.ts";
import { pathKey, schemaType, type JsonSchema } from "./config-form.shared.ts";

export type ConfigSchemaAnalysis = {
  schema: JsonSchema | null;
  unsupportedPaths: string[];
};

const META_KEYS = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "default",
  "deprecated",
  "nullable",
  "enumIncludesNull",
  "examples",
  "readOnly",
  "tags",
  "writeOnly",
  "x-tags",
]);
const SUPPORTED_CONSTRAINT_ONLY_KEYS = new Set([
  ...META_KEYS,
  "const",
  "required",
  "additionalProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
]);
const SUPPORTED_FORM_SCHEMA_KEYS = new Set([
  ...SUPPORTED_CONSTRAINT_ONLY_KEYS,
  "type",
  "properties",
  "items",
  "additionalItems",
  "enum",
  "anyOf",
  "oneOf",
  "allOf",
]);
const RENDERABLE_UNION_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
]);

function isAnySchema(schema: JsonSchema): boolean {
  const keys = Object.keys(schema ?? {}).filter((key) => !META_KEYS.has(key));
  return keys.length === 0;
}

function normalizeEnum(values: unknown[]): { enumValues: unknown[]; nullable: boolean } {
  const filtered = values.filter((value) => value != null);
  const nullable = filtered.length !== values.length;
  return { enumValues: uniqueSchemaValues(filtered), nullable };
}

function uniqueSchemaValues(values: unknown[]): unknown[] {
  const unique: unknown[] = [];
  for (const value of values) {
    if (!unique.some((existing) => Object.is(existing, value))) {
      unique.push(value);
    }
  }
  return unique;
}

function inferredSchemaTypes(schema: JsonSchema, seen = new Set<JsonSchema>()): Set<string> {
  if (seen.has(schema)) {
    return new Set();
  }
  seen.add(schema);
  const types = new Set<string>();
  const declared = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  for (const type of declared) {
    if (type !== "null") {
      types.add(type);
    }
  }
  if (types.size === 0) {
    if (schema.properties || schema.additionalProperties) {
      types.add("object");
    }
  }
  for (const entry of schema.allOf ?? []) {
    for (const type of inferredSchemaTypes(entry, seen)) {
      types.add(type);
    }
  }
  seen.delete(schema);
  return types;
}

function intersectedSchemaType(types: ReadonlySet<string>): string | undefined {
  if (types.size === 1) {
    return types.values().next().value;
  }
  if (types.size > 1 && [...types].every((type) => type === "number" || type === "integer")) {
    return types.has("integer") ? "integer" : "number";
  }
  return undefined;
}

function hasIncompatibleTypes(types: ReadonlySet<string>): boolean {
  return types.size > 1 && intersectedSchemaType(types) === undefined;
}

function inferredSchemaType(schema: JsonSchema): string | undefined {
  return intersectedSchemaType(inferredSchemaTypes(schema));
}

function shouldNormalizeAllOfBranch(schema: JsonSchema): boolean {
  return Boolean(
    inferredSchemaType(schema) ||
    schema.items ||
    schema.enum ||
    schema.anyOf ||
    schema.oneOf ||
    schema.allOf,
  );
}

function hasOnlySupportedConstraintKeywords(schema: JsonSchema): boolean {
  return Object.keys(schema).every((key) => SUPPORTED_CONSTRAINT_ONLY_KEYS.has(key));
}

function hasOnlySupportedFormKeywords(schema: JsonSchema): boolean {
  return Object.keys(schema).every(
    (key) =>
      SUPPORTED_FORM_SCHEMA_KEYS.has(key) ||
      // JSON object keys are already strings; constrained names must remain fail-closed.
      (key === "propertyNames" &&
        typeof schema.propertyNames === "object" &&
        schema.propertyNames !== null &&
        !Array.isArray(schema.propertyNames) &&
        Object.keys(schema.propertyNames).length === 1 &&
        Object.hasOwn(schema.propertyNames, "type") &&
        schema.propertyNames.type === "string"),
  );
}

function schemaAllowsNull(schema: JsonSchema, seen = new Set<JsonSchema>()): boolean {
  if (seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  let allowsNull =
    schema.nullable === true || declaredTypes.length === 0 || declaredTypes.includes("null");
  if (schema.const !== undefined) {
    allowsNull = allowsNull && schema.const === null;
  }
  if (schema.enum) {
    allowsNull = allowsNull && schema.enum.some((entry) => entry === null);
  }
  if (schema.allOf) {
    allowsNull = allowsNull && schema.allOf.every((entry) => schemaAllowsNull(entry, seen));
  }
  if (schema.anyOf) {
    allowsNull = allowsNull && schema.anyOf.some((entry) => schemaAllowsNull(entry, seen));
  }
  if (schema.oneOf) {
    allowsNull =
      allowsNull && schema.oneOf.filter((entry) => schemaAllowsNull(entry, seen)).length === 1;
  }
  seen.delete(schema);
  return allowsNull;
}

function hasUnrepresentableComposedAdditionalProperties(schema: JsonSchema): boolean {
  const schemas: JsonSchema[] = [];
  const pending = [schema];
  const seen = new Set<JsonSchema>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    schemas.push(current);
    pending.push(...(current.allOf ?? []));
  }
  if (schemas.length <= 1) {
    return false;
  }
  const propertyKeys = new Set(schemas.flatMap((entry) => Object.keys(entry.properties ?? {})));
  return schemas.some((entry) => {
    const policy = entry.additionalProperties;
    return (
      Boolean(policy) &&
      typeof policy === "object" &&
      Object.keys(policy).length > 0 &&
      [...propertyKeys].some((key) => !Object.hasOwn(entry.properties ?? {}, key))
    );
  });
}

export function analyzeConfigSchema(raw: unknown): ConfigSchemaAnalysis {
  if (!raw || typeof raw !== "object") {
    return { schema: null, unsupportedPaths: ["<root>"] };
  }
  return normalizeSchemaNode(raw as JsonSchema, []);
}

function normalizeSchemaNode(
  schema: JsonSchema,
  path: Array<string | number>,
  compositionBranch = false,
  inheritedCompositionType?: string,
  inheritedCompositionAllowsNull?: boolean,
): ConfigSchemaAnalysis {
  const unsupported = new Set<string>();
  const normalized: JsonSchema = { ...schema };
  const pathLabel = pathKey(path) || "<root>";

  if (!hasOnlySupportedFormKeywords(schema)) {
    unsupported.add(pathLabel);
  }

  if (schema.anyOf || schema.oneOf) {
    const union = normalizeUnion(schema, path);
    if (union) {
      return {
        schema: union.schema,
        unsupportedPaths: Array.from(new Set([...unsupported, ...union.unsupportedPaths])),
      };
    }
    return { schema, unsupportedPaths: [pathLabel] };
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((entry) => entry !== "null")
    : [];
  const inferredTypes = inferredSchemaTypes(schema);
  const inheritedCompositionOnly =
    compositionBranch &&
    Boolean(inheritedCompositionType) &&
    schema.type === undefined &&
    inferredTypes.size === 0;
  if (inheritedCompositionOnly && inheritedCompositionType) {
    inferredTypes.add(inheritedCompositionType);
  }
  if (
    compositionBranch &&
    inheritedCompositionType &&
    inferredTypes.size > 0 &&
    hasIncompatibleTypes(new Set([...inferredTypes, inheritedCompositionType]))
  ) {
    unsupported.add(pathLabel);
  }
  if (new Set(declaredTypes).size > 1 || hasIncompatibleTypes(inferredTypes)) {
    unsupported.add(pathLabel);
  }
  const type = intersectedSchemaType(inferredTypes);
  const allowsNull =
    schemaAllowsNull(schema) &&
    (inheritedCompositionAllowsNull === undefined || inheritedCompositionAllowsNull);

  if (schema.allOf) {
    const normalizedAllOf: JsonSchema[] = [];
    for (const entry of schema.allOf) {
      if (!entry || typeof entry !== "object") {
        unsupported.add(pathLabel);
        continue;
      }
      if (!shouldNormalizeAllOfBranch(entry)) {
        normalizedAllOf.push(entry);
        if (!hasOnlySupportedConstraintKeywords(entry)) {
          unsupported.add(pathLabel);
        }
        continue;
      }
      const result = normalizeSchemaNode(entry, path, true, type, allowsNull);
      normalizedAllOf.push(result.schema ?? entry);
      for (const unsupportedPath of result.unsupportedPaths) {
        unsupported.add(unsupportedPath);
      }
    }
    normalized.allOf = normalizedAllOf;
  }

  normalized.type = type ?? schema.type;
  normalized.nullable = allowsNull;
  const hasLocalObjectStructure =
    schema.properties !== undefined || schema.additionalProperties !== undefined;
  const hasLocalArrayStructure = schema.items !== undefined || schema.additionalItems !== undefined;

  if (normalized.enum) {
    const { enumValues, nullable: enumNullable } = normalizeEnum(normalized.enum);
    normalized.enum = enumValues;
    normalized.enumIncludesNull = enumNullable && allowsNull;
    if (enumValues.length === 0) {
      unsupported.add(pathLabel);
    }
  }
  if (schema.allOf && allowsNull && !normalized.enumIncludesNull) {
    unsupported.add(pathLabel);
  }

  if (type === "object" && (!inheritedCompositionOnly || hasLocalObjectStructure)) {
    const properties = schema.properties ?? {};
    const propertyKeys = new Set(objectPropertyKeys(schema));
    const additionalProperties = objectAdditionalPropertiesSchema(schema);
    if (
      [...requiredPropertyKeys(schema)].some((key) => !propertyKeys.has(key)) &&
      !additionalProperties
    ) {
      unsupported.add(pathLabel);
    }
    if (hasUnrepresentableComposedAdditionalProperties(schema)) {
      unsupported.add(pathLabel);
    }
    const normalizedProps: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (compositionBranch && !shouldNormalizeAllOfBranch(value)) {
        normalizedProps[key] = value;
        if (!hasOnlySupportedConstraintKeywords(value)) {
          unsupported.add(pathKey([...path, key]) || "<root>");
        }
        continue;
      }
      const res = normalizeSchemaNode(value, [...path, key], compositionBranch);
      if (res.schema) {
        normalizedProps[key] = res.schema;
      }
      for (const entry of res.unsupportedPaths) {
        unsupported.add(entry);
      }
    }
    normalized.properties = normalizedProps;

    if (schema.allOf) {
      for (const key of objectPropertyKeys(schema)) {
        const effectiveSchema = objectPropertySchema(schema, key);
        if (!effectiveSchema) {
          continue;
        }
        const result = normalizeSchemaNode(effectiveSchema, [...path, key]);
        for (const unsupportedPath of result.unsupportedPaths) {
          unsupported.add(unsupportedPath);
        }
      }
    }

    if (schema.additionalProperties === true) {
      // Treat `true` as an untyped map schema so dynamic object keys can still be edited.
      normalized.additionalProperties = {};
    } else if (schema.additionalProperties === false) {
      normalized.additionalProperties = false;
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      if (!isAnySchema(schema.additionalProperties)) {
        const res = normalizeSchemaNode(
          schema.additionalProperties,
          [...path, "*"],
          compositionBranch,
        );
        normalized.additionalProperties = res.schema ?? schema.additionalProperties;
        if (res.unsupportedPaths.length > 0) {
          unsupported.add(pathLabel);
        }
      }
    }
  } else if (type === "array" && (!inheritedCompositionOnly || hasLocalArrayStructure)) {
    if (Array.isArray(schema.items)) {
      const normalizedItems: JsonSchema[] = [];
      for (let index = 0; index < schema.items.length; index += 1) {
        const itemSchema = schema.items[index];
        if (!itemSchema) {
          unsupported.add(pathLabel);
          continue;
        }
        if (compositionBranch && !shouldNormalizeAllOfBranch(itemSchema)) {
          normalizedItems.push(itemSchema);
          if (!hasOnlySupportedConstraintKeywords(itemSchema)) {
            unsupported.add(pathLabel);
          }
          continue;
        }
        const result = normalizeSchemaNode(itemSchema, [...path, index], compositionBranch);
        normalizedItems.push(result.schema ?? itemSchema);
        for (const unsupportedPath of result.unsupportedPaths) {
          unsupported.add(unsupportedPath);
        }
      }
      normalized.items = normalizedItems;
      if (schema.additionalItems && typeof schema.additionalItems === "object") {
        if (compositionBranch && !shouldNormalizeAllOfBranch(schema.additionalItems)) {
          normalized.additionalItems = schema.additionalItems;
          if (!hasOnlySupportedConstraintKeywords(schema.additionalItems)) {
            unsupported.add(pathLabel);
          }
        } else {
          const result = normalizeSchemaNode(
            schema.additionalItems,
            [...path, "*"],
            compositionBranch,
          );
          normalized.additionalItems = result.schema ?? schema.additionalItems;
          for (const unsupportedPath of result.unsupportedPaths) {
            unsupported.add(unsupportedPath);
          }
        }
      } else {
        normalized.additionalItems = schema.additionalItems;
      }
    } else if (!schema.items) {
      unsupported.add(pathLabel);
    } else {
      if (compositionBranch && !shouldNormalizeAllOfBranch(schema.items)) {
        normalized.items = schema.items;
        if (!hasOnlySupportedConstraintKeywords(schema.items)) {
          unsupported.add(pathLabel);
        }
      } else {
        const res = normalizeSchemaNode(schema.items, [...path, "*"], compositionBranch);
        normalized.items = res.schema ?? schema.items;
        if (res.unsupportedPaths.length > 0) {
          unsupported.add(pathLabel);
        }
      }
    }
    if (schema.allOf) {
      for (const index of arrayItemSchemaIndexes(schema)) {
        const effectiveSchema = arrayItemSchema(schema, index);
        if (!effectiveSchema) {
          continue;
        }
        const result = normalizeSchemaNode(effectiveSchema, [...path, index]);
        for (const unsupportedPath of result.unsupportedPaths) {
          unsupported.add(unsupportedPath);
        }
      }
    }
  } else if (
    !(inheritedCompositionOnly && (type === "object" || type === "array")) &&
    type !== "string" &&
    type !== "number" &&
    type !== "integer" &&
    type !== "boolean" &&
    !normalized.enum &&
    !(compositionBranch && schema.allOf)
  ) {
    unsupported.add(pathLabel);
  }

  return {
    schema: normalized,
    unsupportedPaths: Array.from(unsupported),
  };
}

function isSecretRefVariant(entry: JsonSchema): boolean {
  if (schemaType(entry) !== "object") {
    return false;
  }
  const source = entry.properties?.source;
  const provider = entry.properties?.provider;
  const id = entry.properties?.id;
  if (!source || !provider || !id) {
    return false;
  }
  return (
    typeof source.const === "string" &&
    schemaType(provider) === "string" &&
    schemaType(id) === "string"
  );
}

function isSecretRefUnion(entry: JsonSchema): boolean {
  const variants = entry.oneOf ?? entry.anyOf;
  if (!variants || variants.length === 0) {
    return false;
  }
  return variants.every((variant) => isSecretRefVariant(variant));
}

function normalizeSecretInputUnion(
  schema: JsonSchema,
  path: Array<string | number>,
  remaining: JsonSchema[],
  nullable: boolean,
): ConfigSchemaAnalysis | null {
  const stringIndex = remaining.findIndex((entry) => schemaType(entry) === "string");
  if (stringIndex < 0) {
    return null;
  }
  const nonString = remaining.filter((_, index) => index !== stringIndex);
  const secretRefSchema = nonString[0];
  const stringSchema = remaining[stringIndex];
  if (nonString.length !== 1 || !secretRefSchema || !stringSchema) {
    return null;
  }
  if (!isSecretRefUnion(secretRefSchema)) {
    return null;
  }
  return normalizeSchemaNode(
    {
      ...schema,
      ...stringSchema,
      nullable: nullable || stringSchema.nullable,
      anyOf: undefined,
      oneOf: undefined,
      allOf: undefined,
    },
    path,
  );
}

function normalizeUnion(
  schema: JsonSchema,
  path: Array<string | number>,
): ConfigSchemaAnalysis | null {
  // Union normalization replaces the composition keywords, so mixed allOf schemas
  // must stay unsupported instead of silently losing sibling restrictions.
  if (schema.allOf) {
    return null;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (!union) {
    return null;
  }

  const literals: unknown[] = [];
  const remaining: JsonSchema[] = [];
  let nullable = false;

  for (const entry of union) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    if (Array.isArray(entry.enum)) {
      const { enumValues, nullable: enumNullable } = normalizeEnum(entry.enum);
      literals.push(...enumValues);
      if (enumNullable) {
        nullable = true;
      }
      continue;
    }
    if ("const" in entry) {
      if (entry.const == null) {
        nullable = true;
        continue;
      }
      literals.push(entry.const);
      continue;
    }
    if (schemaType(entry) === "null") {
      nullable = true;
      continue;
    }
    remaining.push(entry);
  }
  nullable = nullable && schemaAllowsNull(schema);

  // Config secrets accept either a raw key string or a structured secret ref object.
  // The form only supports editing the string path for now.
  const secretInput = normalizeSecretInputUnion(schema, path, remaining, nullable);
  if (secretInput) {
    return secretInput;
  }

  // An exact boolean branch is finite, except oneOf cannot absorb boolean literals
  // that also match that branch. Open, nullable, or constrained branches stay in Raw mode.
  if (literals.length > 0 && remaining.length > 0) {
    const booleanBranch = remaining.length === 1 ? remaining[0] : undefined;
    const plainBooleanBranch =
      booleanBranch?.type === "boolean" && Object.keys(booleanBranch).length === 1;
    if (
      !plainBooleanBranch ||
      literals.includes("true") ||
      literals.includes("false") ||
      (schema.anyOf === undefined && literals.some((literal) => typeof literal === "boolean"))
    ) {
      return null;
    }
    remaining.pop();
    literals.unshift(true, false);
  }

  if (literals.length > 0 && remaining.length === 0) {
    return {
      schema: {
        ...schema,
        enum: uniqueSchemaValues(literals),
        nullable,
        enumIncludesNull: nullable,
        anyOf: undefined,
        oneOf: undefined,
        allOf: undefined,
      },
      unsupportedPaths: [],
    };
  }

  if (remaining.length === 1) {
    const remainingSchema = remaining[0];
    if (!remainingSchema) {
      return null;
    }
    return normalizeSchemaNode(
      {
        ...schema,
        ...remainingSchema,
        nullable: nullable || remainingSchema.nullable,
        anyOf: undefined,
        oneOf: undefined,
        allOf: undefined,
      },
      path,
    );
  }

  if (
    remaining.length > 0 &&
    literals.length === 0 &&
    remaining.every((entry) => {
      const type = schemaType(entry);
      return Boolean(type) && RENDERABLE_UNION_TYPES.has(String(type));
    })
  ) {
    return {
      schema: {
        ...schema,
        nullable,
      },
      unsupportedPaths: [],
    };
  }

  return null;
}
