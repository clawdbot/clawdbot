import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeHostConfig } from "../../node-host/config.js";
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
  tls: boolean;
  tlsFingerprint?: string;
  bootstrapToken: string;
};

export function resolveNodePairGatewayOptions(input: string): NodePairGatewayOptions {
  const payload = decodePairingSetupCode(input);
  const url = new URL(payload.url);
  const tls = url.protocol === "wss:";
  const port = url.port ? Number.parseInt(url.port, 10) : tls ? 443 : 80;
  return {
    host: url.hostname,
    port,
    tls,
    ...(payload.tlsFingerprint ? { tlsFingerprint: payload.tlsFingerprint } : {}),
    bootstrapToken: payload.bootstrapToken,
  };
}

export function resolveNodeGatewayOptions(
  options: NodeGatewayOptions,
  config: NodeHostConfig | null,
  pair?: NodePairGatewayOptions,
) {
  const baselineHost = pair?.host ?? config?.gateway?.host ?? "127.0.0.1";
  const baselinePort = pair?.port ?? config?.gateway?.port ?? 18789;
  const host = normalizeOptionalString(options.host) || baselineHost;
  const port = options.port === undefined ? baselinePort : parsePort(options.port);
  const endpointChanged = host !== baselineHost || (port !== null && port !== baselinePort);
  const baselineTlsFingerprint = pair?.tlsFingerprint ?? config?.gateway?.tlsFingerprint;
  const baselineTls = pair?.tls ?? config?.gateway?.tls;
  const tlsFingerprint =
    options.tls === false
      ? undefined
      : (normalizeOptionalString(options.tlsFingerprint) ??
        (endpointChanged ? undefined : baselineTlsFingerprint));
  const tls =
    typeof options.tls === "boolean"
      ? options.tls
      : Boolean(tlsFingerprint) || (endpointChanged ? undefined : baselineTls);
  const contextPath =
    normalizeOptionalString(options.contextPath) ??
    (options.contextPath !== undefined || endpointChanged
      ? undefined
      : config?.gateway?.contextPath);

  return { host, port, contextPath, tls, tlsFingerprint };
}
