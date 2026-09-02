/**
 * Runtime control for gateway WebSocket logging verbosity.
 */
export type GatewayWsLogStyle = "auto" | "full" | "compact";

let gatewayWsLogStyle: GatewayWsLogStyle = "auto";

/** Overrides gateway WebSocket log formatting for tests or explicit runtime config. */
export function setGatewayWsLogStyle(style: GatewayWsLogStyle): void {
  gatewayWsLogStyle = style;
}

/** Returns the active gateway WebSocket log style. */
export function getGatewayWsLogStyle(): GatewayWsLogStyle {
  return gatewayWsLogStyle;
}

export const DEFAULT_WS_SLOW_MS = 50;
