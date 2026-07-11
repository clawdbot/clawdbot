// Gateway node pairing auto-approval policy.
// Allows first-time node pairing from configured CIDRs while rejecting upgrades/browser paths.
import { isTrustedProxyAddress } from "./net.js";

export type NodePairingAutoApproveReason =
  | "not-paired"
  | "role-upgrade"
  | "scope-upgrade"
  | "metadata-upgrade";

export type NodePairingAutoApproveClientIpSource =
  | "direct"
  | "trusted-proxy"
  | "loopback-trusted-proxy"
  | "none";

/** Classifies how the gateway learned the client IP for node auto-approval. */
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

/** Shared eligibility inputs for non-interactive first-time node pairing approvals. */
export type FreshNodePairingEligibilityParams = {
  existingPairedDevice: boolean;
  role: string;
  reason: NodePairingAutoApproveReason;
  scopes: readonly string[];
  hasBrowserOriginHeader: boolean;
  isControlUi: boolean;
  isWebchat: boolean;
  reportedClientIpSource: NodePairingAutoApproveClientIpSource;
  reportedClientIp?: string;
};

/**
 * Shared floor for every non-interactive node pairing approval (trusted-CIDR,
 * SSH-verified): only a fresh, scopeless, non-browser `role: node` request
 * with a directly attributable client IP qualifies. Upgrades and spoofable
 * loopback trusted-proxy header paths always stay on the manual prompt.
 */
export function isEligibleFreshNodePairingRequest(
  params: FreshNodePairingEligibilityParams,
): boolean {
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
  return Boolean(params.reportedClientIp);
}

/** Returns true when a node pairing request can be auto-approved by trusted CIDR policy. */
export function shouldAutoApproveNodePairingFromTrustedCidrs(
  params: FreshNodePairingEligibilityParams & {
    autoApproveCidrs?: readonly string[];
  },
): boolean {
  if (!isEligibleFreshNodePairingRequest(params) || !params.reportedClientIp) {
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
