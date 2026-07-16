import type { ResolvedSynologyChatAccount } from "./types.js";

export function collectSynologyChatSecurityAuditFindings(params: {
  accountId?: string | null;
  account: ResolvedSynologyChatAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}) {
  if (!params.account.dangerouslyAllowNameMatching) {
    return [];
  }
  const accountId = params.accountId?.trim() || params.account.accountId || "default";
  const accountNote =
    params.orderedAccountIds.length > 1 || params.hasExplicitAccountPath
      ? ` (account: ${accountId})`
      : "";
  return [
    {
      checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
      severity: "info" as const,
      title: `Synology Chat dangerous name matching is enabled${accountNote}`,
      detail:
        "dangerouslyAllowNameMatching=true re-enables mutable username/nickname matching for reply delivery. This is a break-glass compatibility mode, not a hardened default.",
      remediation:
        "Prefer stable numeric Synology Chat user IDs for reply delivery, then disable dangerouslyAllowNameMatching.",
    },
  ];
}
