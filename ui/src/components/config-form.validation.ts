// Control UI helpers validate schema-backed values without arbitrary depth cutoffs.
import type { JsonSchema } from "./config-form.shared.ts";

type DecimalRational = {
  numerator: bigint;
  denominator: bigint;
};

export function decimalRational(value: number): DecimalRational | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const [coefficientText = "", exponentText] = String(value).toLowerCase().split("e");
  const negative = coefficientText.startsWith("-");
  const coefficient = negative ? coefficientText.slice(1) : coefficientText;
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const exponent = Number(exponentText ?? 0);
  const digits = BigInt(`${whole}${fraction}`);
  const fractionalPlaces = fraction.length - exponent;
  const numerator = fractionalPlaces < 0 ? digits * 10n ** BigInt(-fractionalPlaces) : digits;
  return {
    numerator: negative ? -numerator : numerator,
    denominator: fractionalPlaces > 0 ? 10n ** BigInt(fractionalPlaces) : 1n,
  };
}

function isNumericMultiple(value: number, multipleOf: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(multipleOf) || multipleOf <= 0) {
    return false;
  }
  const valueRational = decimalRational(value);
  const multipleRational = decimalRational(multipleOf);
  if (!valueRational || !multipleRational) {
    return false;
  }
  const dividend = valueRational.numerator * multipleRational.denominator;
  const divisor = valueRational.denominator * multipleRational.numerator;
  return divisor !== 0n && dividend % divisor === 0n;
}

function configValuesEqualInternal(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => configValuesEqualInternal(entry, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        configValuesEqualInternal(leftRecord[key], rightRecord[key]),
    )
  );
}

function isAcyclicValue(
  value: unknown,
  active = new WeakSet<object>(),
  complete = new WeakSet<object>(),
): boolean {
  if (!value || typeof value !== "object") {
    return true;
  }
  if (complete.has(value)) {
    return true;
  }
  if (active.has(value)) {
    return false;
  }
  active.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value);
  const acyclic = entries.every((entry) => isAcyclicValue(entry, active, complete));
  active.delete(value);
  if (acyclic) {
    complete.add(value);
  }
  return acyclic;
}

export function configValuesEqual(left: unknown, right: unknown): boolean {
  return isAcyclicValue(left) && isAcyclicValue(right) && configValuesEqualInternal(left, right);
}

function matchesJsonSchemaType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    default:
      return false;
  }
}

export function ownPropertySchema(schema: JsonSchema, key: string): JsonSchema | undefined {
  const properties = schema.properties;
  return properties && Object.hasOwn(properties, key) ? properties[key] : undefined;
}

function validateSupportedConfigValue(
  schema: JsonSchema,
  value: unknown,
  active: Map<JsonSchema, Set<unknown>>,
): boolean {
  let activeValues = active.get(schema);
  if (activeValues?.has(value)) {
    return true;
  }
  if (!activeValues) {
    activeValues = new Set();
    active.set(schema, activeValues);
  }
  activeValues.add(value);
  try {
    if (
      (schema.allOf &&
        !schema.allOf.every((entry) => validateSupportedConfigValue(entry, value, active))) ||
      (schema.anyOf &&
        !schema.anyOf.some((entry) => validateSupportedConfigValue(entry, value, active))) ||
      (schema.oneOf &&
        schema.oneOf.filter((entry) => validateSupportedConfigValue(entry, value, active))
          .length !== 1)
    ) {
      return false;
    }
    if (schema.const !== undefined && !configValuesEqual(schema.const, value)) {
      return false;
    }
    if (schema.enum && !schema.enum.some((entry) => configValuesEqual(entry, value))) {
      if (!(value === null && schema.nullable && schema.enumIncludesNull)) {
        return false;
      }
    }
    if (value === null && schema.nullable) {
      return true;
    }
    const declaredTypes =
      typeof schema.type === "string"
        ? [schema.type]
        : Array.isArray(schema.type)
          ? schema.type
          : [];
    if (
      declaredTypes.length > 0 &&
      !declaredTypes.some((type) => matchesJsonSchemaType(type, value))
    ) {
      return false;
    }
    if (typeof value === "string") {
      const length = Array.from(value).length;
      if (
        (schema.minLength !== undefined && length < schema.minLength) ||
        (schema.maxLength !== undefined && length > schema.maxLength)
      ) {
        return false;
      }
      if (schema.pattern) {
        try {
          if (!new RegExp(schema.pattern, "u").test(value)) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    }
    if (typeof value === "number") {
      return (
        Number.isFinite(value) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum) &&
        (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum) &&
        (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum) &&
        (schema.multipleOf === undefined || isNumericMultiple(value, schema.multipleOf))
      );
    }
    if (Array.isArray(value)) {
      if (
        (schema.minItems !== undefined && value.length < schema.minItems) ||
        (schema.maxItems !== undefined && value.length > schema.maxItems) ||
        (schema.uniqueItems === true &&
          value.some((item, index) =>
            value.slice(index + 1).some((candidate) => configValuesEqual(item, candidate)),
          ))
      ) {
        return false;
      }
      const items = schema.items;
      if (!Array.isArray(items)) {
        return items
          ? value.every((item) => validateSupportedConfigValue(items, item, active))
          : true;
      }
      return value.every((item, index) => {
        const itemSchema = items[index];
        if (itemSchema) {
          return validateSupportedConfigValue(itemSchema, item, active);
        }
        return schema.additionalItems && typeof schema.additionalItems === "object"
          ? validateSupportedConfigValue(schema.additionalItems, item, active)
          : schema.additionalItems !== false;
      });
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if ((schema.required ?? []).some((key) => !Object.hasOwn(record, key))) {
        return false;
      }
      return Object.entries(record).every(([key, entryValue]) => {
        const propertySchema = ownPropertySchema(schema, key);
        if (propertySchema) {
          return validateSupportedConfigValue(propertySchema, entryValue, active);
        }
        return schema.additionalProperties && typeof schema.additionalProperties === "object"
          ? validateSupportedConfigValue(schema.additionalProperties, entryValue, active)
          : schema.additionalProperties !== false;
      });
    }
    switch (typeof value) {
      case "boolean":
        return true;
      default:
        return value === null;
    }
  } finally {
    activeValues.delete(value);
    if (activeValues.size === 0) {
      active.delete(schema);
    }
  }
}

export function isSupportedConfigValueValid(schema: JsonSchema, value: unknown): boolean {
  return validateSupportedConfigValue(schema, value, new Map());
}
