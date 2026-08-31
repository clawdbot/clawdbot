/** Test-only gateway request scope type projections. */
import { withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

export * from "./gateway-request-scope.js";

export type PluginRuntimeGatewayRequestScope = Parameters<
  typeof withPluginRuntimeGatewayRequestScope
>[0];
