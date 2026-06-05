// Gateway method runtime helpers dispatch plugin calls through the in-process gateway.
import { dispatchGatewayMethodInProcessRaw } from "../gateway/server-plugins.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";

/** Error envelope returned by in-process Gateway method dispatch. */
export type GatewayMethodDispatchError = {
  /** Stable machine-readable error code returned by the Gateway method. */
  code: string;
  /** Human-readable error summary safe to forward to the plugin caller. */
  message: string;
  /** Optional structured method-specific diagnostics. */
  details?: unknown;
  /** Whether the caller can retry the same request without changing params. */
  retryable?: boolean;
  /** Suggested delay before retrying when the Gateway can estimate backoff. */
  retryAfterMs?: number;
};

/** Response envelope returned to plugins after dispatching a Gateway method. */
export type GatewayMethodDispatchResponse = {
  /** True when the Gateway method completed and `payload` contains its result. */
  ok: boolean;
  /** Method-specific result payload for successful responses. */
  payload?: unknown;
  /** Gateway error envelope for failed responses. */
  error?: GatewayMethodDispatchError;
  /** Optional response metadata that plugins may pass through unchanged. */
  meta?: Record<string, unknown>;
};

/** Dispatch controls for plugin-initiated Gateway method calls. */
export type GatewayMethodDispatchOptions = {
  /** Wait for the Gateway's final response instead of returning the first response frame. */
  expectFinal?: boolean;
  /** Maximum time to wait for Gateway dispatch before the runtime reports a timeout. */
  timeoutMs?: number;
};

/**
 * Dispatch a Gateway control-plane method from an authenticated plugin request scope.
 */
export async function dispatchGatewayMethod(
  /** Gateway method name, validated by the Gateway method router. */
  method: string,
  /** Method-specific params forwarded without SDK-side normalization. */
  params?: unknown,
  /** Dispatch behavior controls for response timing and timeout handling. */
  options?: GatewayMethodDispatchOptions,
): Promise<GatewayMethodDispatchResponse> {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (scope?.gatewayMethodDispatchAllowed !== true) {
    // Gateway methods can mutate/control local runtime state; require the
    // authenticated HTTP-route scope recorded by the plugin loader contract.
    const pluginLabel = scope?.pluginId ? ` for plugin "${scope.pluginId}"` : "";
    throw new Error(
      `Gateway method dispatch is reserved for plugin HTTP routes that declare contracts.gatewayMethodDispatch: ["authenticated-request"]${pluginLabel}.`,
    );
  }
  return await dispatchGatewayMethodInProcessRaw(method, params, {
    disableSyntheticClient: true,
    requireScopedClient: true,
    ...(options?.expectFinal !== undefined ? { expectFinal: options.expectFinal } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
