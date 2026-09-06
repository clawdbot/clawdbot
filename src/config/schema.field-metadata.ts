import type { z } from "zod";
import { walkConfigSchema } from "./schema.walk.js";
import { configUiMetadata } from "./zod-schema.sensitive.js";

export type ConfigSchemaShape<T extends object> = {
  [Key in keyof T]-?: z.ZodType<T[Key]>;
};

/** Derive documented paths from the schema instead of maintaining a second field inventory. */
export function projectConfigFieldMetadata(schema: z.ZodType, path: string) {
  const labels: Record<string, string> = {};
  const help: Record<string, string> = {};
  walkConfigSchema(schema, path, (fieldSchema, fieldPath) => {
    const metadata = configUiMetadata.get(fieldSchema);
    // The outer wrapper owns overrides, e.g. a field-specific description of a shared object.
    if (typeof metadata?.label === "string") {
      labels[fieldPath] ??= metadata.label;
    }
    if (typeof metadata?.help === "string") {
      help[fieldPath] ??= metadata.help;
    }
  });
  return { labels, help };
}
