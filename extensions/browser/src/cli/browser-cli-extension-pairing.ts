export function resolveLocalPairingGatewayUrl(params: {
  configuredRemote?: string;
  gatewayPort: number;
  tlsEnabled: boolean;
}): string {
  if (params.configuredRemote) {
    return params.configuredRemote;
  }
  if (params.tlsEnabled) {
    throw new Error("Gateway TLS pairing requires --gateway-url wss://<certificate-host>[:port]");
  }
  return `ws://127.0.0.1:${params.gatewayPort}`;
}
