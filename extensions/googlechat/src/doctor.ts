import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isGoogleChatMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const withoutPrefix = text.replace(/^(googlechat|google-chat|gchat):/i, "").trim();
  if (!withoutPrefix) {
    return false;
  }

  const withoutUsers = withoutPrefix.replace(/^users\//i, "");
  return withoutUsers.includes("@");
}

export const collectGoogleChatMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "googlechat",
    detector: isGoogleChatMutableAllowEntry,
    collectLists: (scope) => {
      const lists = [
        {
          pathLabel: `${scope.prefix}.groupAllowFrom`,
          list: scope.account.groupAllowFrom,
        },
      ];
      const dm = asObjectRecord(scope.account.dm);
      if (dm) {
        lists.push({
          pathLabel: `${scope.prefix}.dm.allowFrom`,
          list: dm.allowFrom,
        });
      }
      const groups = asObjectRecord(scope.account.groups);
      if (groups) {
        for (const [groupKey, groupRaw] of Object.entries(groups)) {
          const group = asObjectRecord(groupRaw);
          if (!group) {
            continue;
          }
          lists.push({
            pathLabel: `${scope.prefix}.groups.${groupKey}.users`,
            list: group.users,
          });
        }
      }
      return lists;
    },
  });
