import type { PluginWidgetPresenterRegistration } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

/** Returns presenter registrations from the exact request registry when available. */
export function resolveWidgetPresenters(): readonly PluginWidgetPresenterRegistration[] {
  const registry =
    getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry() ?? undefined;
  return registry?.widgetPresenters ?? [];
}
