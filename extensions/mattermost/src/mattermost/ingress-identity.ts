import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/access-groups";
import type {
  ChannelIngressIdentifierKind,
  StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const MATTERMOST_USER_NAME_KIND =
  "plugin:mattermost-user-name" as const satisfies ChannelIngressIdentifierKind;
export const mattermostIngressIdentity = {
  key: "sender-id",
  // Authenticated Mattermost WebSocket post events carry the server-owned post.user_id.
  authentication: "verified",
  normalize: normalizeMattermostAllowEntry,
  aliases: [
    {
      key: "sender-name",
      kind: MATTERMOST_USER_NAME_KIND,
      normalizeEntry: normalizeMattermostAllowEntry,
      normalizeSubject: normalizeMattermostAllowEntry,
      authentication: "mutable",
    },
  ],
  isWildcardEntry: (entry) => normalizeMattermostAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `mattermost-entry-${entryIndex + 1}:${fieldKey === "sender-name" ? "name" : "user"}`,
} satisfies StableChannelIngressIdentityParams;

export function normalizeMattermostAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  const accessGroupName = parseAccessGroupAllowFromEntry(trimmed);
  if (accessGroupName) {
    return `accessGroup:${accessGroupName}`;
  }
  const normalized = trimmed
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim();
  return normalized ? normalizeLowercaseStringOrEmpty(normalized) : "";
}
