import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { handlePluginsCommand } from "./commands-plugins.js";

/** Chat commands execute within the Gateway instance that admitted the request. */
export function runPluginsCommand(...args: Parameters<typeof handlePluginsCommand>) {
  const context = {
    applyPluginLifecycleChange: async ({ pluginIds }: { pluginIds: readonly string[] }) => ({
      operationId: "chat-install",
      generation: 2,
      pluginIds: [...pluginIds],
    }),
  } as unknown as GatewayRequestContext;
  return withPluginRuntimeGatewayContextResolver(
    () => context,
    () => handlePluginsCommand(...args),
  );
}
