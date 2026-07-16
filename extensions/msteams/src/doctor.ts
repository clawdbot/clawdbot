import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";

function isMSTeamsMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const withoutPrefix = text.replace(/^(msteams|user):/i, "").trim();
  return /\s/.test(withoutPrefix) || withoutPrefix.includes("@");
}

export const collectMSTeamsMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "msteams",
    detector: isMSTeamsMutableAllowEntry,
    collectLists: (scope) => [
      {
        pathLabel: `${scope.prefix}.allowFrom`,
        list: scope.account.allowFrom,
      },
      {
        pathLabel: `${scope.prefix}.groupAllowFrom`,
        list: scope.account.groupAllowFrom,
      },
    ],
  });
