// Zod parse helpers wrap schema parsing with consistent error handling.
import type { ZodType } from "zod";

/**
 * Null-returning Zod parse helpers for plugin and runtime boundaries.
 *
 * Callers use these where invalid external payloads should be ignored or
 * recovered from without constructing and catching validation errors.
 */

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
