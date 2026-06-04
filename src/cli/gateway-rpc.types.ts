// Shared RPC option shape for gateway CLI commands.
/** Common gateway RPC flags accepted by direct gateway command helpers. */
export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
};
