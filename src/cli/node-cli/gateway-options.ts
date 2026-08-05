import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodeHostConfig } from "../../node-host/config.js";
import { parsePort } from "../daemon-cli/shared.js";

type NodeGatewayOptions = {
  host?: string;
  port?: string | number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
};

export function resolveNodeGatewayOptions(
  options: NodeGatewayOptions,
  config: NodeHostConfig | null,
) {
  const savedHost = config?.gateway?.host || "127.0.0.1";
  const savedPort = config?.gateway?.port ?? 18789;
  const host = normalizeOptionalString(options.host) || savedHost;
  const port = options.port === undefined ? savedPort : parsePort(options.port);
  const endpointChanged = host !== savedHost || (port !== null && port !== savedPort);
  const tlsFingerprint =
    options.tls === false
      ? undefined
      : (normalizeOptionalString(options.tlsFingerprint) ??
        (endpointChanged ? undefined : config?.gateway?.tlsFingerprint));
  const tls =
    typeof options.tls === "boolean"
      ? options.tls
      : Boolean(tlsFingerprint) || (endpointChanged ? undefined : config?.gateway?.tls);
  const contextPath =
    normalizeOptionalString(options.contextPath) ??
    (options.contextPath !== undefined || endpointChanged
      ? undefined
      : config?.gateway?.contextPath);

  return { host, port, contextPath, tls, tlsFingerprint };
}
