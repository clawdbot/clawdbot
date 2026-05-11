import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isIrcMutableAllowEntry(raw: string): boolean {
  const text = normalizeLowercaseStringOrEmpty(raw);
  if (!text || text === "*") {
    return false;
  }

  const normalized = text
    .replace(/^irc:/, "")
    .replace(/^user:/, "")
    .trim();

  return !normalized.includes("!") && !normalized.includes("@");
}

export const collectIrcMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "irc",
    detector: isIrcMutableAllowEntry,
    collectLists: (scope) => {
      const lists = [
        {
          pathLabel: `${scope.prefix}.allowFrom`,
          list: scope.account.allowFrom,
        },
        {
          pathLabel: `${scope.prefix}.groupAllowFrom`,
          list: scope.account.groupAllowFrom,
        },
      ];
      const groups = asObjectRecord(scope.account.groups);
      if (groups) {
        for (const [groupKey, groupRaw] of Object.entries(groups)) {
          const group = asObjectRecord(groupRaw);
          if (!group) {
            continue;
          }
          lists.push({
            pathLabel: `${scope.prefix}.groups.${groupKey}.allowFrom`,
            list: group.allowFrom,
          });
        }
      }
      return lists;
    },
  });
