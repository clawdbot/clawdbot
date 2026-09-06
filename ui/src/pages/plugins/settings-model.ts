import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JsonSchema } from "../../lib/config-form-utils.ts";

function schemaProperty(schema: JsonSchema | null, key: string): JsonSchema | null {
  const properties = schema?.properties;
  return properties && Object.hasOwn(properties, key) ? (properties[key] ?? null) : null;
}

function pluginEntrySchema(rootSchema: JsonSchema | null, pluginId: string): JsonSchema | null {
  const plugins = schemaProperty(rootSchema, "plugins");
  const entries = schemaProperty(plugins, "entries");
  const fallback = entries?.additionalProperties;
  return (
    schemaProperty(entries, pluginId) ??
    (fallback && typeof fallback === "object" ? fallback : null)
  );
}

export function pluginConfigSchema(
  rootSchema: JsonSchema | null,
  pluginId: string,
): JsonSchema | null {
  return schemaProperty(pluginEntrySchema(rootSchema, pluginId), "config");
}

export function pluginAdvancedSchema(rootSchema: JsonSchema | null): JsonSchema | null {
  const plugins = schemaProperty(rootSchema, "plugins");
  if (!plugins?.properties) {
    return null;
  }
  const properties = Object.fromEntries(
    ["enabled", "allow", "deny", "load", "slots"].flatMap((key) => {
      const schema = plugins.properties?.[key];
      return schema ? [[key, schema] as const] : [];
    }),
  );
  return { ...plugins, properties };
}

export function pluginEntryValue(
  config: Record<string, unknown> | null,
  pluginId: string,
): Record<string, unknown> {
  const plugins = asNullableRecord(config?.plugins);
  const entries = asNullableRecord(plugins?.entries);
  return entries && Object.hasOwn(entries, pluginId)
    ? (asNullableRecord(entries[pluginId]) ?? {})
    : {};
}
