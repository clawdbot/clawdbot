/** Process-global key shared by lightweight request-scope readers. */
export const PLUGIN_RUNTIME_GATEWAY_REQUEST_SCOPE_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntimeGatewayRequestScope",
);
