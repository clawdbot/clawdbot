import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedZalouserAccount } from "./accounts.js";

export function isZalouserMutableGroupEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }
  const normalized = text
    .replace(/^(zalouser|zlu):/i, "")
    .replace(/^group:/i, "")
    .trim();
  if (!normalized) {
    return false;
  }
  if (/^\d+$/.test(normalized)) {
    return false;
  }
  return !/^g-\S+$/i.test(normalized);
}

export function collectZalouserSecurityAuditFindings(params: {
  accountId?: string | null;
  account: ResolvedZalouserAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}) {
  const zalouserCfg = params.account.config ?? {};
  const accountId = params.accountId?.trim() || params.account.accountId || "default";
  const dangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(zalouserCfg);
  const zalouserPathPrefix =
    params.orderedAccountIds.length > 1 || params.hasExplicitAccountPath
      ? `channels.zalouser.accounts.${accountId}`
      : "channels.zalouser";
  const mutableGroupEntries = new Set<string>();
  const groups = zalouserCfg.groups;
  if (groups && typeof groups === "object" && !Array.isArray(groups)) {
    for (const key of Object.keys(groups as Record<string, unknown>)) {
      if (!isZalouserMutableGroupEntry(key)) {
        continue;
      }
      mutableGroupEntries.add(`${zalouserPathPrefix}.groups:${key}`);
    }
  }
  if (mutableGroupEntries.size === 0) {
    return [];
  }
  const examples = Array.from(mutableGroupEntries).slice(0, 5);
  const more =
    mutableGroupEntries.size > examples.length
      ? ` (+${mutableGroupEntries.size - examples.length} more)`
      : "";
  const severity: "info" | "warn" = dangerousNameMatchingEnabled ? "info" : "warn";
  return [
    {
      checkId: "channels.zalouser.groups.mutable_entries",
      severity,
      title: dangerousNameMatchingEnabled
        ? "Zalouser group routing uses break-glass name matching"
        : "Zalouser group routing contains mutable group entries",
      detail: dangerousNameMatchingEnabled
        ? "Zalouser group-name routing is explicitly enabled via dangerouslyAllowNameMatching. This mutable-identity mode is operator-selected break-glass behavior and out-of-scope for vulnerability reports by itself. " +
          `Found: ${examples.join(", ")}${more}.`
        : "Zalouser group auth is ID-only by default, so unresolved group-name or slug entries are ignored for auth and can drift from the intended trusted group. " +
          `Found: ${examples.join(", ")}${more}.`,
      remediation: dangerousNameMatchingEnabled
        ? "Prefer stable Zalo group IDs (for example group:<id> or provider-native g- ids), then disable dangerouslyAllowNameMatching."
        : "Prefer stable Zalo group IDs in channels.zalouser.groups, or explicitly opt in with dangerouslyAllowNameMatching=true if you accept mutable group-name matching.",
    },
  ];
}
