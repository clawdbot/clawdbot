/**
 * Provider-safe TypeBox string enum helpers.
 *
 * Emits flat `enum` schemas instead of `anyOf` unions so provider tool-schema validators accept them.
 */
import { Type } from "typebox";

type StringEnumOptions<T extends readonly string[]> = {
  description?: string;
  title?: string;
  default?: T[number];
  deprecated?: boolean;
};

export function stringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  const enumValues = Array.isArray(values)
    ? values
    : values && typeof values === "object"
      ? Object.values(values).filter((value): value is T[number] => typeof value === "string")
      : [];
  return enumValues.length === 0
    ? Type.Unsafe<T[number]>({ type: "string", ...options })
    : Type.Enum(enumValues, { type: "string", ...options });
}

export function optionalStringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  return Type.Optional(stringEnum(values, options));
}
