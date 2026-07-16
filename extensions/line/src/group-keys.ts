import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import type { LineConfig, LineGroupConfig } from "./types.js";

export function resolveLineGroupLookupIds(groupId?: string | null): string[] {
  const normalized = groupId?.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.startsWith("group:") || normalized.startsWith("room:")) {
    const rawId = normalized.split(":").slice(1).join(":");
    return rawId ? [rawId, normalized] : [normalized];
  }
  return [normalized, `group:${normalized}`, `room:${normalized}`];
}

export function resolveLineGroupConfigEntry<T>(
  groups: Record<string, T | undefined> | undefined,
  params: { groupId?: string | null; roomId?: string | null },
): T | undefined {
  if (!groups) {
    return undefined;
  }
  for (const candidate of resolveLineGroupLookupIds(params.groupId)) {
    const hit = groups[candidate];
    if (hit) {
      return hit;
    }
  }
  for (const candidate of resolveLineGroupLookupIds(params.roomId)) {
    const hit = groups[candidate];
    if (hit) {
      return hit;
    }
  }
  return groups["*"];
}

export function resolveLineGroupsConfig(
  cfg: OpenClawConfig,
  accountId?: string | null,
): Record<string, LineGroupConfig | undefined> | undefined {
  const lineConfig = cfg.channels?.line as LineConfig | undefined;
  if (!lineConfig) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accountGroups = resolveAccountEntry(lineConfig.accounts, normalizedAccountId)?.groups;
  return accountGroups ?? lineConfig.groups;
}

export function resolveExactLineGroupConfigKey(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
}): string | undefined {
  const groups = resolveLineGroupsConfig(params.cfg, params.accountId);
  if (!groups) {
    return undefined;
  }
  return resolveLineGroupLookupIds(params.groupId).find((candidate) =>
    Object.hasOwn(groups, candidate),
  );
}
