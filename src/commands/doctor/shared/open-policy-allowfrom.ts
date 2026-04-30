import { ensureOpenDmPolicyAllowFromWildcard } from "../../../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { resolveAllowFromMode, type AllowFromMode } from "./allow-from-mode.js";
import { asObjectRecord } from "./object.js";

export function collectOpenPolicyAllowFromWarnings(params: {
  changes: string[];
  doctorFixCommand: string;
}): string[] {
  if (params.changes.length === 0) {
    return [];
  }
  return [
    ...params.changes.map((line) => sanitizeForLog(line)),
    `- Run "${params.doctorFixCommand}" to add missing allowFrom wildcards.`,
  ];
}

export function maybeRepairOpenPolicyAllowFrom(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const ensureWildcard = (
    account: Record<string, unknown>,
    prefix: string,
    mode: AllowFromMode,
  ) => {
    ensureOpenDmPolicyAllowFromWildcard({
      entry: account,
      mode,
      pathPrefix: prefix,
      changes,
    });
  };

  const nextChannels = next.channels as Record<string, Record<string, unknown>>;
  for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }

    const allowFromMode = resolveAllowFromMode(channelName);
    ensureWildcard(channelConfig, `channels.${channelName}`, allowFromMode);

    const accounts = asObjectRecord(channelConfig.accounts);
    if (!accounts) {
      continue;
    }
    for (const [accountName, accountConfig] of Object.entries(accounts)) {
      if (accountConfig && typeof accountConfig === "object") {
        ensureWildcard(
          accountConfig as Record<string, unknown>,
          `channels.${channelName}.accounts.${accountName}`,
          allowFromMode,
        );
      }
    }
  }

  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: next, changes };
}
