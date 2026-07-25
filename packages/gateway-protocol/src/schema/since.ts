import type { TSchema } from "typebox";

/** Adds protocol-vintage metadata without changing the schema's validated value shape. */
export function withSince<T extends TSchema>(train: string, schema: T): T {
  Object.assign(schema, { "x-openclaw-since": train });
  return schema;
}
