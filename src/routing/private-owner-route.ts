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
  const plugin = getLoadedChannelPluginById(channel);
  const normalizedTo = normalizeLowercaseStringOrEmpty(target.to);
  const targetIds = new Set([
    normalizedTo,
    normalizedTo.startsWith("user:")
      ? normalizeLowercaseStringOrEmpty(normalizedTo.slice("user:".length))
      : "",
  ]);
  const keys = new Set<string>();
  for (const to of targetIds) {
    if (!to) {
      continue;
    }
    keys.add(to);
    keys.add(`user:${to}`);
    if (!channel) {
      continue;
    }
    // Private adapters can type targets as `user:<id>`. Include the untyped
    // ID so the same native owner identity still matches its configured route.
    keys.add(`${channel}:${to}`);
    for (const prefix of plugin?.messaging?.targetPrefixes ?? []) {
      const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
      if (normalizedPrefix) {
        keys.add(`${normalizedPrefix}:${to}`);
      }
    }
  }
  return keys;
}
