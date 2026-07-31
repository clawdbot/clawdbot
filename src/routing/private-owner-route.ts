import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginById } from "../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Returns the configured owner preference for a concrete private route target. */
export function resolvePrivateOwnerRoutePreference(params: {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
}): number {
  const owners = params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(owners) || owners.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  const keys = buildPrivateOwnerRouteKeys(params);
  const index = owners.findIndex((owner) =>
    keys.has(normalizeLowercaseStringOrEmpty(String(owner))),
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** Checks that a private route target is an explicitly configured command owner. */
export function isPrivateOwnerRouteTarget(params: {
  cfg: OpenClawConfig;
  channel: string;
  to: string;
}): boolean {
  return resolvePrivateOwnerRoutePreference(params) !== Number.MAX_SAFE_INTEGER;
}

function buildPrivateOwnerRouteKeys(target: { channel: string; to: string }): Set<string> {
  const channel = normalizeLowercaseStringOrEmpty(target.channel);
  const to = normalizeLowercaseStringOrEmpty(target.to);
  const keys = new Set<string>();
  if (to) {
    keys.add(to);
    keys.add(`user:${to}`);
  }
  if (channel && to) {
    keys.add(`${channel}:${to}`);
    for (const prefix of getLoadedChannelPluginById(channel)?.messaging?.targetPrefixes ?? []) {
      const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
      if (normalizedPrefix) {
        keys.add(`${normalizedPrefix}:${to}`);
      }
    }
  }
  return keys;
}
