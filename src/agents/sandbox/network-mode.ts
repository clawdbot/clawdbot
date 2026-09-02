/**
 * Docker network mode safety helpers.
 *
 * Flags host networking and container namespace joins because they bypass normal sandbox network isolation.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/** Reason a requested network mode is blocked by sandbox policy. */
type NetworkModeBlockReason = "host" | "container_namespace_join";

/** Normalizes optional Docker network mode strings for policy checks. */
export function normalizeNetworkMode(network: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(network);
  return normalized || undefined;
}

/** Returns the concrete block reason for dangerous network modes, if blocked. */
export function getBlockedNetworkModeReason(params: {
  network: string | undefined;
  allowContainerNamespaceJoin?: boolean;
}): NetworkModeBlockReason | null {
  const normalized = normalizeNetworkMode(params.network);
  if (!normalized) {
    return null;
  }
  if (normalized === "host") {
    return "host";
  }
  if (normalized.startsWith("container:") && params.allowContainerNamespaceJoin !== true) {
    // Joining another container namespace can inherit unexpected network reachability.
    return "container_namespace_join";
  }
  return null;
}

/** Returns whether a network mode weakens sandbox network isolation. */
export function isDangerousNetworkMode(network: string | undefined): boolean {
  const normalized = normalizeNetworkMode(network);
  return normalized === "host" || normalized?.startsWith("container:") === true;
}
