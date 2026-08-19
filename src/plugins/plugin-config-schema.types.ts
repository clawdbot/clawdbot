import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type { PluginConfigUiHint } from "./manifest-types.js";

type PluginConfigValidation = { ok: true; value?: unknown } | { ok: false; errors: string[] };

/**
 * Config schema contract accepted by plugin manifests and runtime registration.
 *
 * Plugins can provide a Zod-like parser, a lightweight `validate(...)`
 * function, or both. `jsonSchema` is optional runtime schema metadata.
 */
export type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => {
    success: boolean;
    data?: unknown;
    error?: {
      issues?: Array<{ path: Array<string | number>; message: string }>;
    };
  };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  /**
   * @deprecated Declare config presentation metadata in the plugin's
   * `openclaw.plugin.json` manifest via top-level `uiHints`. The host reads
   * manifest hints and does not consume runtime config-schema hints.
   */
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: JsonSchemaObject;
};
