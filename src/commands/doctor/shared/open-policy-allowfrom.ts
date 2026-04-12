import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { resolveAllowFromMode, type AllowFromMode } from "./allow-from-mode.js";
import { asObjectRecord } from "./object.js";

function hasWildcard(list?: Array<string | number>) {
  return list?.some((v) => normalizeOptionalString(String(v)) === "*") ?? false;
}

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
    const dmEntry = account.dm;
    const dm =
      dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
        ? (dmEntry as Record<string, unknown>)
        : undefined;
    const dmPolicy =
      (account.dmPolicy as string | undefined) ?? (dm?.policy as string | undefined) ?? undefined;
    const canCanonicalizeTopLevel = mode !== "nestedOnly";
    const hadNestedOpenPolicy =
      canCanonicalizeTopLevel && account.dmPolicy === undefined && dm?.policy === "open";

    if (dmPolicy !== "open") {
      return;
    }

    const topAllowFrom = account.allowFrom as Array<string | number> | undefined;
    const nestedAllowFrom = dm?.allowFrom as Array<string | number> | undefined;

    if (hadNestedOpenPolicy) {
      account.dmPolicy = "open";
      delete dm.policy;
      changes.push(`- ${prefix}.dmPolicy: set to "open" (migrated from ${prefix}.dm.policy)`);
    }

    if (
      canCanonicalizeTopLevel &&
      !Array.isArray(topAllowFrom) &&
      Array.isArray(nestedAllowFrom) &&
      hasWildcard(nestedAllowFrom)
    ) {
      account.allowFrom = [...nestedAllowFrom];
      delete dm?.allowFrom;
      changes.push(
        `- ${prefix}.allowFrom: moved ${hasWildcard(nestedAllowFrom) ? "wildcard " : ""}allowlist from ${prefix}.dm.allowFrom`,
      );
    }

    if (dm && Object.keys(dm).length === 0) {
      delete account.dm;
    }

    if (mode === "nestedOnly") {
      if (hasWildcard(nestedAllowFrom)) {
        return;
      }
      if (dm && Array.isArray(nestedAllowFrom)) {
        dm.allowFrom = [...nestedAllowFrom, "*"];
        changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
      } else {
        const nextDm = dm ?? {};
        nextDm.allowFrom = ["*"];
        account.dm = nextDm;
        changes.push(`- ${prefix}.dm.allowFrom: set to ["*"] (required by dmPolicy="open")`);
      }
      return;
    }

    if (mode === "topOrNested") {
      if (hasWildcard(topAllowFrom) || hasWildcard(nestedAllowFrom)) {
        return;
      }
      if (Array.isArray(topAllowFrom)) {
        account.allowFrom = [...topAllowFrom, "*"];
        changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
      } else if (dm && Array.isArray(nestedAllowFrom)) {
        dm.allowFrom = [...nestedAllowFrom, "*"];
        changes.push(`- ${prefix}.dm.allowFrom: added "*" (required by dmPolicy="open")`);
      } else {
        account.allowFrom = ["*"];
        changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
      }
      return;
    }

    if (hasWildcard(topAllowFrom)) {
      return;
    }
    if (Array.isArray(topAllowFrom)) {
      account.allowFrom = [...topAllowFrom, "*"];
      changes.push(`- ${prefix}.allowFrom: added "*" (required by dmPolicy="open")`);
    } else {
      account.allowFrom = ["*"];
      changes.push(`- ${prefix}.allowFrom: set to ["*"] (required by dmPolicy="open")`);
    }
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
