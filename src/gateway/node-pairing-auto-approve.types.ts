/** How the gateway attributed the client IP used by node pairing policy. */
export type NodePairingAutoApproveClientIpSource =
  | "direct"
  | "trusted-proxy"
  | "loopback-trusted-proxy"
  | "none";
