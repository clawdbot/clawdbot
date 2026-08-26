import { isWssUrl } from "@openclaw/net-policy/url-protocol";
import { requireTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import type { GatewayTlsConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayTlsRuntime } from "../infra/tls/gateway.js";

type GatewayTlsRuntimeLoader = (config: GatewayTlsConfig | undefined) => Promise<GatewayTlsRuntime>;

/** Resolve the certificate pin for one already-selected Gateway target. */
export async function resolveGatewayConnectionTlsFingerprint(params: {
  config: OpenClawConfig;
  url: string;
  urlSource: string;
  explicitTlsFingerprint?: string;
  loadGatewayTlsRuntime: GatewayTlsRuntimeLoader;
}): Promise<string | undefined> {
  const explicitTlsFingerprint = params.explicitTlsFingerprint
    ? requireTlsFingerprint(params.explicitTlsFingerprint)
    : undefined;
  if (explicitTlsFingerprint) {
    return explicitTlsFingerprint;
  }

  // Env overrides intentionally retain remote-mode pinning for private-cert deployments.
  // CLI targets and local fallback are distinct trust decisions and must not inherit that pin.
  const remoteTlsFingerprint =
    params.config.gateway?.mode === "remote" &&
    (params.urlSource === "config gateway.remote.url" ||
      params.urlSource === "env OPENCLAW_GATEWAY_URL")
      ? params.config.gateway.remote?.tlsFingerprint
        ? requireTlsFingerprint(params.config.gateway.remote.tlsFingerprint)
        : undefined
      : undefined;
  if (remoteTlsFingerprint) {
    return remoteTlsFingerprint;
  }
  if (!isWssUrl(params.url)) {
    return undefined;
  }

  const usesConfiguredLocalGateway =
    params.urlSource === "local loopback" ||
    params.urlSource === "missing gateway.remote.url (fallback local)";
  if (!usesConfiguredLocalGateway || params.config.gateway?.tls?.enabled !== true) {
    return undefined;
  }
  const tlsRuntime = await params.loadGatewayTlsRuntime(params.config.gateway.tls);
  return tlsRuntime.enabled ? tlsRuntime.fingerprintSha256 : undefined;
}
