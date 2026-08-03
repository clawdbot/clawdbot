// Gateway TLS boundary loads listener certificate material from gateway config.
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import {
  type GatewayTlsRuntime,
  loadGatewayTlsRuntime as loadGatewayTlsRuntimeConfig,
} from "../../infra/tls/gateway.js";

/**
 * Gateway TLS runtime loader boundary.
 */
export type { GatewayTlsRuntime } from "../../infra/tls/gateway.js";

/** Loads certificate/key material for the gateway listener from config. */
export async function loadGatewayTlsRuntime(
  cfg: GatewayTlsConfig | undefined,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<GatewayTlsRuntime> {
  return await loadGatewayTlsRuntimeConfig(cfg, log);
}
