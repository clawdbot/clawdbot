import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

export function validateControlUiNativeRoutePlacement(params: {
  record: PluginRecord;
  placement: string | undefined;
  pushDiagnostic: PluginRegistryState["pushDiagnostic"];
}): boolean {
  if (!params.placement?.startsWith("route:")) {
    return true;
  }
  if (params.record.origin === "bundled" && params.placement === `route:${params.record.id}`) {
    return true;
  }
  params.pushDiagnostic({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `native Control UI route placement must be owned by its bundled plugin: ${params.placement}`,
  });
  return false;
}
