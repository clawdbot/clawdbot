import { isTrustedProxyAddress } from "./net.js";

export type NodePairingAutoApproveReason =
  | "not-paired"
  | "role-upgrade"
  | "scope-upgrade"
  | "metadata-upgrade";

type NodePairingAutoApproveClientIpSource =
  | "direct"
  | "trusted-proxy"
  | "loopback-trusted-proxy"
  | "none";

export function resolveNodePairingClientIpSource(params: {
  reportedClientIp?: string;
  hasProxyHeaders: boolean;
  remoteIsTrustedProxy: boolean;
  remoteIsLoopback: boolean;
}): NodePairingAutoApproveClientIpSource {
  if (!params.reportedClientIp) {
    return "none";
  }
  if (!params.hasProxyHeaders || !params.remoteIsTrustedProxy) {
    return "direct";
  }
  return params.remoteIsLoopback ? "loopback-trusted-proxy" : "trusted-proxy";
}

export function shouldAutoApproveNodePairingFromTrustedCidrs(params: {
  existingPairedDevice: boolean;
  role: string;
  reason: NodePairingAutoApproveReason;
  scopes: readonly string[];
  hasBrowserOriginHeader: boolean;
  isControlUi: boolean;
  isWebchat: boolean;
  reportedClientIpSource: NodePairingAutoApproveClientIpSource;
  reportedClientIp?: string;
  autoApproveCidrs?: readonly string[];
}): boolean {
  if (params.existingPairedDevice) {
    return false;
  }
  if (params.role !== "node") {
    return false;
  }
  if (params.reason !== "not-paired") {
    return false;
  }
  if (params.scopes.length > 0) {
    return false;
  }
  if (params.hasBrowserOriginHeader || params.isControlUi || params.isWebchat) {
    return false;
  }
  if (
    params.reportedClientIpSource === "none" ||
    params.reportedClientIpSource === "loopback-trusted-proxy"
  ) {
    return false;
  }
  if (!params.reportedClientIp) {
    return false;
  }

  const autoApproveCidrs = params.autoApproveCidrs
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!autoApproveCidrs || autoApproveCidrs.length === 0) {
    return false;
  }

  return isTrustedProxyAddress(params.reportedClientIp, autoApproveCidrs);
}
