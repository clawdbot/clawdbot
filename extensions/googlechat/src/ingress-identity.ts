import { defineStableChannelIngressIdentity } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeGoogleChatUserId(raw?: string | null): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^users\//i, ""));
}

const GOOGLECHAT_EMAIL_KIND = "plugin:googlechat-email" as const;

function normalizeEntryValue(raw?: string | null): string {
  return normalizeLowercaseStringOrEmpty(raw ?? "");
}

function normalizeGoogleChatStableEntry(entry: string): string | null {
  const withoutProvider = normalizeEntryValue(entry).replace(
    /^(googlechat|google-chat|gchat):/i,
    "",
  );
  if (!withoutProvider) {
    return null;
  }
  return withoutProvider.startsWith("users/")
    ? normalizeGoogleChatUserId(withoutProvider)
    : withoutProvider;
}

function normalizeGoogleChatEmailEntry(entry: string): string | null {
  const withoutProvider = normalizeEntryValue(entry).replace(
    /^(googlechat|google-chat|gchat):/i,
    "",
  );
  if (withoutProvider.startsWith("users/")) {
    return null;
  }
  const stable = normalizeGoogleChatStableEntry(entry);
  return stable?.includes("@") ? stable : null;
}

export const googleChatIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  // Google signs the webhook for the configured audience before sender.name is consumed.
  authentication: "verified",
  normalizeEntry: normalizeGoogleChatStableEntry,
  normalizeSubject: normalizeGoogleChatUserId,
  aliases: [
    {
      key: "email",
      kind: GOOGLECHAT_EMAIL_KIND,
      normalizeEntry: normalizeGoogleChatEmailEntry,
      normalizeSubject: normalizeEntryValue,
      authentication: "mutable",
    },
  ],
  isWildcardEntry: (entry) => normalizeEntryValue(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    fieldKey === "stableId"
      ? `entry-${entryIndex + 1}:user`
      : `entry-${entryIndex + 1}:${fieldKey}`,
});
