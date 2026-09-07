import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { requireTlsFingerprint } from "../../../packages/gateway-client/src/client-address-utils.js";
import type { NodeHostConfig, NodeHostGatewayConfig } from "../../node-host/config.js";
import {
  nodeHostCloudflareAccessConfigFromEnv,
  nodeHostGatewaysShareOrigin,
} from "../../node-host/gateway-cloudflare-access.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import { parsePort } from "../daemon-cli/shared.js";

type NodeGatewayOptions = {
  host?: string;
  port?: string | number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
};

type NodePairGatewayOptions = {
  host: string;
  port: number;
  contextPath?: string;
  tls: boolean;
  tlsFingerprint?: string;
  bootstrapToken: string;
  candidates: NodeHostGatewayConfig[];
};

type PairingSetupPayload = ReturnType<typeof decodePairingSetupCode>;

function gatewayConfigFromUrl(url: string, tlsFingerprint?: string): NodeHostGatewayConfig {
  const parsed = new URL(url);
  const tls = parsed.protocol === "wss:";
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : tls ? 443 : 80,
    ...(parsed.pathname !== "/" ? { contextPath: parsed.pathname } : {}),
    tls,
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
  };
}

export function resolveNodePairGatewayOptions(input: string): NodePairGatewayOptions {
  return resolveNodePairGatewayPayload(decodePairingSetupCode(input));
}

/** Project a validated pairing payload into the canonical node-host candidate list. */
export function resolveNodePairGatewayPayload(
  payload: PairingSetupPayload,
): NodePairGatewayOptions {
  const candidates = (payload.urls ?? [payload.url]).map((url) =>
    gatewayConfigFromUrl(url, url === payload.url ? payload.tlsFingerprint : undefined),
  );
  const primary = candidates[0]!;
  return {
    host: primary.host ?? "127.0.0.1",
    port: primary.port ?? 18789,
    ...(primary.contextPath ? { contextPath: primary.contextPath } : {}),
    tls: primary.tls ?? false,
    ...(primary.tlsFingerprint ? { tlsFingerprint: primary.tlsFingerprint } : {}),
    bootstrapToken: payload.bootstrapToken,
    candidates,
  };
}

export function resolveNodeGatewayOptions(
  options: NodeGatewayOptions,
  config: NodeHostConfig | null,
  pair?: NodePairGatewayOptions,
  env: NodeJS.ProcessEnv = process.env,
) {
  const baselineHost = pair?.host ?? config?.gateway?.host ?? "127.0.0.1";
  const baselinePort = pair?.port ?? config?.gateway?.port ?? 18789;
  const host = normalizeOptionalString(options.host) || baselineHost;
  const port = options.port === undefined ? baselinePort : parsePort(options.port);
  const endpointChanged = host !== baselineHost || (port !== null && port !== baselinePort);
  const baselineTlsFingerprint = pair?.tlsFingerprint ?? config?.gateway?.tlsFingerprint;
  const selectedTlsFingerprint =
    options.tls === false
      ? undefined
      : options.tlsFingerprint !== undefined
        ? options.tlsFingerprint
        : endpointChanged
          ? undefined
          : baselineTlsFingerprint;
  const baselineTls = pair?.tls ?? config?.gateway?.tls;
  const tlsFingerprint = selectedTlsFingerprint
    ? requireTlsFingerprint(selectedTlsFingerprint)
    : undefined;
  const tls =
    typeof options.tls === "boolean"
      ? options.tls
      : Boolean(tlsFingerprint) || (endpointChanged ? undefined : baselineTls);
  const contextPath =
    normalizeOptionalString(options.contextPath) ??
    (options.contextPath !== undefined || endpointChanged
      ? undefined
      : (pair?.contextPath ?? config?.gateway?.contextPath));
  const hasExplicitEndpoint =
    options.host !== undefined ||
    options.port !== undefined ||
    options.contextPath !== undefined ||
    options.tls !== undefined ||
    options.tlsFingerprint !== undefined;
  const savedGatewayMatchesBaseline =
    !pair ||
    (config?.gateway !== undefined &&
      nodeHostGatewaysShareOrigin(config.gateway, pair.candidates[0]!));
  const cloudflareAccess =
    (!endpointChanged && savedGatewayMatchesBaseline
      ? config?.gateway?.cloudflareAccess
      : undefined) ?? nodeHostCloudflareAccessConfigFromEnv(env);
  const gatewayCandidates =
    pair && !hasExplicitEndpoint
      ? pair.candidates.map((candidate, index) =>
          index === 0 && cloudflareAccess ? { ...candidate, cloudflareAccess } : candidate,
        )
      : undefined;

  return {
    host,
    port,
    contextPath,
    tls,
    tlsFingerprint,
    cloudflareAccess,
    gatewayCandidates,
  };
}
