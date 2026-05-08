import { Type } from "typebox";

type StringEnumOptions<T extends readonly string[]> = {
  description?: string;
  title?: string;
  default?: T[number];
  deprecated?: boolean;
};

// Avoid Type.Union([Type.Literal(...)]) which compiles to anyOf.
// Some providers reject anyOf in tool schemas; a flat string enum is safer.
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  const enumValues = Array.isArray(values)
    ? values
    : values && typeof values === "object"
      ? Object.values(values).filter((value): value is T[number] => typeof value === "string")
      : [];
  return Type.Unsafe<T[number]>({
    type: "string",
    ...(enumValues.length > 0 ? { enum: [...enumValues] } : {}),
    ...options,
  });
}

export function optionalStringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  return Type.Optional(stringEnum(values, options));
}
