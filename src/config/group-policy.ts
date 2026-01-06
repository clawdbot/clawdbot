import type { ClawdbotConfig } from "./config.js";

export type GroupPolicySurface = "whatsapp" | "telegram" | "imessage";

export type ProviderGroupConfig = {
  requireMention?: boolean;
};

export type ProviderGroupPolicy = {
  allowlistEnabled: boolean;
  allowed: boolean;
  groupConfig?: ProviderGroupConfig;
  defaultConfig?: ProviderGroupConfig;
};

type ProviderGroups = Record<string, ProviderGroupConfig>;

function resolveProviderGroups(
  cfg: ClawdbotConfig,
  surface: GroupPolicySurface,
): ProviderGroups | undefined {
  if (surface === "whatsapp") return cfg.whatsapp?.groups;
  if (surface === "telegram") return cfg.telegram?.groups;
  if (surface === "imessage") return cfg.imessage?.groups;
  return undefined;
}

export function resolveProviderGroupPolicy(params: {
  cfg: ClawdbotConfig;
  surface: GroupPolicySurface;
  groupId?: string | null;
}): ProviderGroupPolicy {
  const { cfg, surface } = params;
  const groups = resolveProviderGroups(cfg, surface);
  const allowlistEnabled = Boolean(groups && Object.keys(groups).length > 0);
  const normalizedId = params.groupId?.trim();
  const groupConfig = normalizedId && groups ? groups[normalizedId] : undefined;
  const defaultConfig = groups?.["*"];
  const allowAll =
    allowlistEnabled && Boolean(groups && Object.hasOwn(groups, "*"));
  const allowed =
    !allowlistEnabled ||
    allowAll ||
    (normalizedId
      ? Boolean(groups && Object.hasOwn(groups, normalizedId))
      : false);
  return {
    allowlistEnabled,
    allowed,
    groupConfig,
    defaultConfig,
  };
}

export function resolveProviderGroupRequireMention(params: {
  cfg: ClawdbotConfig;
  surface: GroupPolicySurface;
  groupId?: string | null;
  requireMentionOverride?: boolean;
  overrideOrder?: "before-config" | "after-config";
}): boolean {
  const { requireMentionOverride, overrideOrder = "after-config" } = params;
  const { groupConfig, defaultConfig } = resolveProviderGroupPolicy(params);
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultConfig?.requireMention === "boolean"
        ? defaultConfig.requireMention
        : undefined;

  if (
    overrideOrder === "before-config" &&
    typeof requireMentionOverride === "boolean"
  ) {
    return requireMentionOverride;
  }
  if (typeof configMention === "boolean") return configMention;
  if (
    overrideOrder !== "before-config" &&
    typeof requireMentionOverride === "boolean"
  ) {
    return requireMentionOverride;
  }
  return true;
}
