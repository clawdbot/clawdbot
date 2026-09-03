import { defineStableChannelIngressIdentity } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildIrcAllowlistCandidates, normalizeIrcAllowEntry } from "./normalize.js";
import type { IrcInboundMessage } from "./types.js";

const IRC_NICK_KIND = "plugin:irc-nick" as const;

export const ircIngressIdentity = defineStableChannelIngressIdentity({
  key: "irc-id",
  // The IRC server vouches for the connection prefix, but does not bind it to an account owner.
  authentication: "asserted",
  normalizeEntry: normalizeIrcStableEntry,
  normalizeSubject: normalizeLowercaseStringOrEmpty,
  sensitivity: "pii",
  aliases: [
    {
      key: "irc-id-nick-user",
      kind: "stable-id" as const,
      normalizeEntry: normalizeIrcNickUserEntry,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      authentication: "mutable",
      sensitivity: "pii" as const,
    },
    {
      key: "irc-id-nick-host",
      kind: "stable-id" as const,
      authentication: "asserted",
      normalizeEntry: normalizeIrcNickHostEntry,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      sensitivity: "pii" as const,
    },
    {
      key: "irc-nick",
      kind: IRC_NICK_KIND,
      normalizeEntry: normalizeIrcNickEntry,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      authentication: "mutable",
      sensitivity: "pii",
    },
  ],
  isWildcardEntry: (entry) => normalizeIrcAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `irc-entry-${entryIndex + 1}:${fieldKey === "irc-nick" ? "nick" : "id"}`,
});

function isBareNick(value: string): boolean {
  return !value.includes("!") && !value.includes("@");
}

function hasVerifiedHost(value: string): boolean {
  return value.includes("@");
}

function isHostlessNickUser(value: string): boolean {
  return value.includes("!") && !value.includes("@");
}

function normalizeIrcStableEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized.includes("!") || !hasVerifiedHost(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeIrcNickHostEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  return !normalized.includes("!") && hasVerifiedHost(normalized) ? normalized : null;
}

function normalizeIrcNickUserEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized || normalized === "*" || !isHostlessNickUser(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeIrcNickEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized || normalized === "*" || !isBareNick(normalized)) {
    return null;
  }
  return normalized;
}

export function createIrcIngressSubject(message: IrcInboundMessage) {
  const candidates = buildIrcAllowlistCandidates(message, { allowNameMatching: true });
  const stableCandidates = candidates.filter((candidate) => hasVerifiedHost(candidate));
  const nick = normalizeLowercaseStringOrEmpty(message.senderNick);
  return {
    stableId: stableCandidates[stableCandidates.length - 1] ?? nick,
    aliases: {
      "irc-id-nick-user": candidates.find((candidate) => isHostlessNickUser(candidate)),
      "irc-id-nick-host": stableCandidates.find(
        (candidate) => !candidate.includes("!") && candidate.includes("@"),
      ),
      "irc-nick": nick,
    },
  };
}
