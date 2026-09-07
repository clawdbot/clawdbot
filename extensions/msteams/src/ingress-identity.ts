// Msteams plugin module owns lightweight sender identity normalization and audit classification.
import type {
  IdentifierAuthentication,
  StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const MSTEAMS_SENDER_NAME_KIND = "plugin:msteams-sender-name" as const;
const MSTEAMS_CONVERSATION_ID_KIND = "plugin:msteams-conversation-id" as const;
const MSTEAMS_STABLE_USER_ID = /^[0-9a-f-]{16,}$/i;
const MSTEAMS_GROUP_CONVERSATION_ID = /^19:.+@thread\.(?:tacv2|skype|v2)$/i;

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(msteams|teams):/i, "");
}

export function normalizeMSTeamsUserInput(raw: string): string {
  return stripProviderPrefix(raw.trim())
    .replace(/^(user|conversation):/i, "")
    .trim();
}

/** Project static DM principals; only opted-in audits may include resolvable names. */
export function normalizeMSTeamsDmPrincipal(raw: string, allowNameMatching = false): string {
  const trimmed = raw.trim();
  if (trimmed === "*" || /^accessGroup:/i.test(trimmed)) {
    return trimmed;
  }
  // Startup has historically projected conversation-prefixed hexadecimal user IDs.
  const id = normalizeMSTeamsUserInput(trimmed).toLowerCase();
  return isStableMSTeamsUserId(id) ||
    (allowNameMatching && classifyMSTeamsEntryAuthentication(trimmed) === "mutable")
    ? id
    : "";
}

/** Match the stable user-id shape accepted by runtime allowlist projection and targeting. */
export function isStableMSTeamsUserId(raw: string): boolean {
  const unscoped = stripProviderPrefix(raw.trim()).trim();
  if (/^conversation:/i.test(unscoped)) {
    return false;
  }
  return MSTEAMS_STABLE_USER_ID.test(normalizeMSTeamsUserInput(unscoped));
}

export function normalizeMSTeamsConversationId(raw: string): string {
  return raw.split(";")[0] ?? raw;
}

/** Detect supported prefixed and bare Bot Framework or Graph conversation IDs. */
export function looksLikeMSTeamsConversationId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^conversation:/i.test(trimmed)) {
    return true;
  }
  if (MSTEAMS_GROUP_CONVERSATION_ID.test(trimmed)) {
    return true;
  }
  if (/^19:.+@unq\.gbl\.spaces$/i.test(trimmed)) {
    return true;
  }
  if (/^a:1[A-Za-z0-9_-]+$/i.test(trimmed)) {
    return true;
  }
  if (/^8:orgid:[A-Za-z0-9-]+$/i.test(trimmed)) {
    return true;
  }
  return /@thread\b/i.test(trimmed);
}

function normalizeIngressValue(value?: string | null): string | null {
  return normalizeOptionalLowercaseString(value) ?? null;
}

function normalizeMSTeamsIngressUserId(value?: string | null): string | null {
  const normalized = normalizeIngressValue(value);
  if (!normalized) {
    return null;
  }
  const unscoped = stripProviderPrefix(normalized).trim();
  if (/^conversation:/i.test(unscoped)) {
    return null;
  }
  return normalizeMSTeamsUserInput(unscoped) || null;
}

function normalizeSenderNameIngressValue(value?: string | null): string | null {
  const normalized = normalizeIngressValue(value);
  if (!normalized) {
    return null;
  }
  // Conversation allowlist entries must never become spoofable display-name principals.
  return looksLikeMSTeamsConversationId(
    normalizeMSTeamsConversationId(stripProviderPrefix(normalized)),
  )
    ? null
    : normalized;
}

function normalizeAllowlistConversationId(value?: string | null): string | null {
  const trimmed = value?.trim();
  // Microsoft Graph conversation IDs are opaque; case-folding would authorize a different chat.
  return trimmed ? normalizeMSTeamsConversationId(trimmed) : null;
}

export const msteamsIngressIdentity = {
  key: "sender-id",
  // Bot Framework authenticates the connector and vouches for the activity, without this
  // plugin independently proving exact ownership of every from.id representation.
  authentication: "asserted",
  normalize: normalizeMSTeamsIngressUserId,
  aliases: [
    {
      key: "sender-name",
      kind: MSTEAMS_SENDER_NAME_KIND,
      normalizeEntry: normalizeSenderNameIngressValue,
      normalizeSubject: normalizeSenderNameIngressValue,
      authentication: "mutable",
    },
    {
      key: "conversation-id",
      kind: MSTEAMS_CONVERSATION_ID_KIND,
      authentication: "asserted",
      normalizeEntry: normalizeAllowlistConversationId,
      normalizeSubject: normalizeAllowlistConversationId,
    },
  ],
  isWildcardEntry: (entry) => normalizeIngressValue(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `msteams-entry-${entryIndex + 1}:${
      fieldKey === "sender-name"
        ? "name"
        : fieldKey === "conversation-id"
          ? "conversation-id"
          : "id"
    }`,
} satisfies StableChannelIngressIdentityParams;

/** Classify authored DM allowlist entries without loading the Teams runtime. */
export function classifyMSTeamsEntryAuthentication(
  raw: string,
): IdentifierAuthentication | undefined {
  // Audit the startup projection, not a raw inbound identity: legacy typed
  // hexadecimal entries already authorize the projected user. Ingress and
  // approval checks must still reject raw conversation-form identities.
  if (isStableMSTeamsUserId(normalizeMSTeamsUserInput(raw))) {
    return "asserted";
  }
  const normalized = normalizeMSTeamsIngressUserId(raw);
  if (
    !normalized ||
    normalized === "*" ||
    /^accessGroup:/i.test(normalized) ||
    looksLikeMSTeamsConversationId(normalizeMSTeamsConversationId(normalized))
  ) {
    return undefined;
  }
  return "mutable";
}
