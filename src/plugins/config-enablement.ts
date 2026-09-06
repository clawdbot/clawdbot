import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { validatePluginSchemaValue } from "./schema-validator.js";

export type PluginConfigEnablement =
  | { mode: "ready" }
  | { mode: "missing" }
  | { mode: "invalid"; error: string };

export function resolvePluginConfigEnablement(params: {
  config: OpenClawConfig;
  pluginId: string;
  manifest?: PluginManifestRecord;
}): PluginConfigEnablement {
  const manifest = params.manifest;
  if (!manifest?.configSchema) {
    return { mode: "ready" };
  }
  const entry = params.config.plugins?.entries?.[params.pluginId];
  const hasConfig = isRecord(entry) && Object.hasOwn(entry, "config");
  const result = validatePluginSchemaValue({
    origin: manifest.origin,
    schema: manifest.configSchema,
    cacheKey: manifest.schemaCacheKey ?? manifest.manifestPath,
    value: hasConfig ? entry.config : {},
    applyDefaults: true,
  });
  if (result.ok) {
    return { mode: "ready" };
  }
  // A malformed schema cannot be repaired by supplying config. Only a valid
  // schema rejecting absent config represents setup that the operator can finish.
  if (!hasConfig && !result.schemaError) {
    return { mode: "missing" };
  }
  return { mode: "invalid", error: result.errors[0]?.text ?? "invalid plugin config" };
}
