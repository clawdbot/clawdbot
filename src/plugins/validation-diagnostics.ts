// Formats plugin validation diagnostics from manifest and config checks.
import type { PluginDiagnostic } from "./manifest-types.js";

/** Pushes a normalized plugin validation diagnostic. */
export function pushPluginValidationDiagnostic(params: {
  level: PluginDiagnostic["level"];
  pluginId: string;
  source: string;
  message: string;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}) {
  params.pushDiagnostic({
    level: params.level,
    pluginId: params.pluginId,
    source: params.source,
    message: params.message,
  });
}
