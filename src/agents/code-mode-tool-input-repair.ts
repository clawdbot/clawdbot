import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";

function schemaAcceptsValue(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  try {
    return Value.Check(schema as never, value);
  } catch {
    return false;
  }
}

function readComposedSchemaBranches(schema: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf;
  }
  return Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
}

function parseJsonContainer(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) || isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function valuesMatch(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, value);
}

function liftMisplacedRequiredArrayItemFields(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!isRecord(schema.properties) || !Array.isArray(schema.required)) {
    return undefined;
  }
  const missingRequired = schema.required.filter(
    (entry): entry is string => typeof entry === "string" && !Object.hasOwn(value, entry),
  );
  if (missingRequired.length === 0) {
    return undefined;
  }
  let repaired: Record<string, unknown> | undefined;
  for (const requiredKey of missingRequired) {
    const requiredSchema = schema.properties[requiredKey];
    let match:
      | {
          arrayKey: string;
          items: Record<string, unknown>[];
          value: unknown;
        }
      | undefined;
    for (const [arrayKey, rawArray] of Object.entries(repaired ?? value)) {
      const arraySchema = schema.properties[arrayKey];
      if (
        !isRecord(arraySchema) ||
        arraySchema.type !== "array" ||
        !isRecord(arraySchema.items) ||
        (isRecord(arraySchema.items.properties) &&
          Object.hasOwn(arraySchema.items.properties, requiredKey))
      ) {
        continue;
      }
      const parsedArray = parseJsonContainer(rawArray);
      if (
        !Array.isArray(parsedArray) ||
        parsedArray.length === 0 ||
        !parsedArray.every((entry) => isRecord(entry) && Object.hasOwn(entry, requiredKey))
      ) {
        continue;
      }
      const candidate = parsedArray[0]?.[requiredKey];
      if (
        !schemaAcceptsValue(requiredSchema, candidate) ||
        !parsedArray.every((entry) => valuesMatch(entry[requiredKey], candidate))
      ) {
        continue;
      }
      if (match) {
        return undefined;
      }
      match = {
        arrayKey,
        items: parsedArray.map((entry) => {
          const item = Object.create(null) as Record<string, unknown>;
          for (const [key, itemValue] of Object.entries(entry)) {
            if (key !== requiredKey) {
              item[key] = itemValue;
            }
          }
          return item;
        }),
        value: candidate,
      };
    }
    if (!match) {
      continue;
    }
    repaired ??= copyRecord(value);
    repaired[requiredKey] = match.value;
    repaired[match.arrayKey] = match.items;
  }
  return repaired && schemaAcceptsValue(schema, repaired) ? repaired : undefined;
}

export function repairCodeModeToolInput(schema: unknown, value: unknown, depth = 0): unknown {
  if (!isRecord(schema) || depth > 6) {
    return value;
  }
  if (schemaAcceptsValue(schema, value)) {
    return value;
  }
  const composedBranches = readComposedSchemaBranches(schema);
  if (composedBranches?.length) {
    for (const branch of composedBranches) {
      const repaired = repairCodeModeToolInput(branch, value, depth + 1);
      if (repaired !== value && schemaAcceptsValue(schema, repaired)) {
        return repaired;
      }
    }
    return value;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (typeof value === "string") {
    if (types.includes("string")) {
      return value;
    }
    if (types.includes("number") || types.includes("integer")) {
      const trimmed = value.trim();
      if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
        const parsed = Number(trimmed);
        const typeAcceptsParsed =
          types.includes("number") || (types.includes("integer") && Number.isSafeInteger(parsed));
        if (Number.isFinite(parsed) && typeAcceptsParsed && schemaAcceptsValue(schema, parsed)) {
          return parsed;
        }
      }
    }
    if (types.includes("boolean") && (value === "true" || value === "false")) {
      const parsed = value === "true";
      return schemaAcceptsValue(schema, parsed) ? parsed : value;
    }
    if (types.includes("array") || types.includes("object")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (
          (types.includes("array") && Array.isArray(parsed)) ||
          (types.includes("object") && isRecord(parsed))
        ) {
          const repaired = repairCodeModeToolInput(schema, parsed, depth + 1);
          return schemaAcceptsValue(schema, repaired) ? repaired : value;
        }
      } catch {
        // Only complete JSON containers are repaired.
      }
    }
    return value;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    let changed = false;
    const repaired = value.map((entry) => {
      const next = repairCodeModeToolInput(schema.items, entry, depth + 1);
      changed ||= next !== entry;
      return next;
    });
    return changed && schemaAcceptsValue(schema, repaired) ? repaired : value;
  }
  if (!isRecord(value) || !isRecord(schema.properties)) {
    return value;
  }
  const lifted = liftMisplacedRequiredArrayItemFields(schema, value);
  if (lifted) {
    return lifted;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  const repaired = Object.create(null) as Record<string, unknown>;
  let changed = false;
  for (const [key, current] of Object.entries(value)) {
    const propertySchema = schema.properties[key];
    if (
      current === null &&
      propertySchema !== undefined &&
      !required.has(key) &&
      !schemaAcceptsValue(propertySchema, null)
    ) {
      changed = true;
      continue;
    }
    const next =
      propertySchema === undefined
        ? current
        : repairCodeModeToolInput(propertySchema, current, depth + 1);
    changed ||= next !== current;
    Object.defineProperty(repaired, key, {
      configurable: true,
      enumerable: true,
      value: next,
      writable: true,
    });
  }
  return changed && schemaAcceptsValue(schema, repaired) ? repaired : value;
}
