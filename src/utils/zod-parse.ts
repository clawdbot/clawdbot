import type { ZodType } from "zod";

/** Safely validates an unknown value with a Zod schema, returning null on validation failure. */
export function safeParseWithSchema<T>(schema: ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parses JSON, then safely validates it with a Zod schema, returning null for parse or schema failures. */
export function safeParseJsonWithSchema<T>(schema: ZodType<T>, raw: string): T | null {
  try {
    return safeParseWithSchema(schema, JSON.parse(raw));
  } catch {
    return null;
  }
}
