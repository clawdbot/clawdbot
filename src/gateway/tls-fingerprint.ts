import { isWssUrl } from "@openclaw/net-policy/url-protocol";
import { requireTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { inspectGatewayTlsCertificate } from "../infra/tls/gateway.js";

/** Resolve the certificate pin for one already-selected Gateway target. */
export async function resolveGatewayConnectionTlsFingerprint(params: {
  config: OpenClawConfig;
  url: string;
  urlSource: string;
  explicitTlsFingerprint?: string;
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
  const certificate = await inspectGatewayTlsCertificate(params.config.gateway.tls);
  return certificate.ok ? certificate.value.fingerprintSha256 : undefined;
}
