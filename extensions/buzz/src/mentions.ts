import { nip19 } from "nostr-tools";

export const BUZZ_MENTION_MAX_COUNT = 50;
const BUZZ_AMBIGUITY_CANDIDATE_LIMIT = 5;

export type BuzzMentionMember = {
  publicKey: string;
  displayName?: string;
};

const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const NIP_27_PREFIX = "nostr:npub1";
const NPUB_LENGTH = 63;

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function isAsciiWhitespace(character: string | undefined): boolean {
  return character !== undefined && /^[\t-\r ]$/u.test(character);
}

function isOnlyAsciiWhitespace(value: string): boolean {
  return /^[\t-\r ]*$/u.test(value);
}

function isMentionBoundary(value: string): boolean {
  const character = value[0];
  return character === undefined || isAsciiWhitespace(character) || ",;.!?:)]}".includes(character);
}

function stripCodeRegions(content: string): string {
  let output = "";
  let index = 0;
  while (index < content.length) {
    if (content.startsWith("```", index)) {
      const lineStart = content.lastIndexOf("\n", index - 1) + 1;
      const beforeFence = content.slice(lineStart, index);
      if (isOnlyAsciiWhitespace(beforeFence)) {
        const openingLineEnd = content.indexOf("\n", index + 3);
        let searchFrom = openingLineEnd === -1 ? content.length : openingLineEnd + 1;
        let closeEnd = content.length;
        while (searchFrom < content.length) {
          const closingFence = content.indexOf("```", searchFrom);
          if (closingFence === -1) {
            break;
          }
          const closingLineStart = content.lastIndexOf("\n", closingFence - 1) + 1;
          const beforeClosingFence = content.slice(closingLineStart, closingFence);
          if (isOnlyAsciiWhitespace(beforeClosingFence)) {
            const closingLineEnd = content.indexOf("\n", closingFence + 3);
            closeEnd = closingLineEnd === -1 ? content.length : closingLineEnd + 1;
            break;
          }
          searchFrom = closingFence + 3;
        }
        output += " ";
        index = closeEnd;
        continue;
      }
    }

    if (content[index] === "`") {
      const closingTick = content.indexOf("`", index + 1);
      if (closingTick !== -1 && !content.slice(index + 1, closingTick).includes("\n")) {
        output += " ";
        index = closingTick + 1;
        continue;
      }
    }

    output += content[index];
    index += 1;
  }
  return output;
}

function extractNostrPubkeys(content: string): string[] {
  const publicKeys: string[] = [];
  const seen = new Set<string>();
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const start = content.indexOf(NIP_27_PREFIX, searchFrom);
    if (start === -1) {
      break;
    }
    const npubStart = start + "nostr:".length;
    const candidate = content.slice(npubStart, npubStart + NPUB_LENGTH);
    searchFrom = start + NIP_27_PREFIX.length;
    if (candidate.length !== NPUB_LENGTH || !/^[0-9a-z]+$/iu.test(candidate)) {
      continue;
    }
    try {
      const decoded = nip19.decode(asciiLowercase(candidate));
      if (decoded.type !== "npub" || typeof decoded.data !== "string") {
        continue;
      }
      const publicKey = decoded.data.toLowerCase();
      if (HEX_PUBLIC_KEY_PATTERN.test(publicKey) && !seen.has(publicKey)) {
        seen.add(publicKey);
        publicKeys.push(publicKey);
      }
    } catch {
      // Invalid NIP-27 references remain presentation text, matching Buzz.
    }
  }
  return publicKeys;
}

function extractMentionNames(content: string, knownNames: readonly string[]): string[] {
  if (!content.includes("@")) {
    return [];
  }
  const sortedNames = knownNames
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted((left, right) => right.length - left.length);
  const names: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < content.length; index += 1) {
    if (
      content[index] !== "@" ||
      (index > 0 && !isAsciiWhitespace(content[index - 1])) ||
      index + 1 >= content.length
    ) {
      continue;
    }
    const rest = content.slice(index + 1);
    const knownName = sortedNames.find((name) => {
      const candidate = rest.slice(0, name.length);
      return (
        candidate.length === name.length &&
        asciiLowercase(candidate) === asciiLowercase(name) &&
        isMentionBoundary(rest.slice(name.length))
      );
    });
    let name = knownName;
    if (!name) {
      const match = /^[a-z0-9._-]+/iu.exec(rest);
      name = match?.[0];
    }
    if (!name) {
      continue;
    }
    const normalized = asciiLowercase(name);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      names.push(normalized);
    }
  }
  return names;
}

function hasAtMentionCandidate(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    if (
      content[index] === "@" &&
      (index === 0 || isAsciiWhitespace(content[index - 1])) &&
      index + 1 < content.length &&
      !isAsciiWhitespace(content[index + 1])
    ) {
      return true;
    }
  }
  return false;
}

function normalizeMembers(members: readonly BuzzMentionMember[]): Map<string, BuzzMentionMember> {
  const normalized = new Map<string, BuzzMentionMember>();
  for (const member of members) {
    const publicKey = member.publicKey.trim().toLowerCase();
    if (!HEX_PUBLIC_KEY_PATTERN.test(publicKey)) {
      continue;
    }
    normalized.set(publicKey, {
      publicKey,
      displayName: member.displayName?.trim() || undefined,
    });
  }
  return normalized;
}

export function inspectBuzzMentionSyntax(text: string): {
  hasAtMention: boolean;
  hasExplicitIdentity: boolean;
} {
  const stripped = stripCodeRegions(text);
  return {
    hasAtMention: hasAtMentionCandidate(stripped),
    hasExplicitIdentity: extractNostrPubkeys(stripped).length > 0,
  };
}

export function resolveBuzzMessageMentions(params: {
  text: string;
  members: readonly BuzzMentionMember[] | undefined;
  senderPublicKey: string;
}): string[] {
  const stripped = stripCodeRegions(params.text);
  const explicitPublicKeys = extractNostrPubkeys(stripped);
  const hasMentionText = hasAtMentionCandidate(stripped) || explicitPublicKeys.length > 0;
  if (!hasMentionText) {
    return [];
  }
  if (!params.members) {
    throw new Error("Buzz room membership is unavailable; retry after the room directory loads");
  }

  const members = normalizeMembers(params.members);
  const senderPublicKey = params.senderPublicKey.trim().toLowerCase();
  const mentions: string[] = [];
  for (const publicKey of explicitPublicKeys) {
    if (publicKey !== senderPublicKey && !mentions.includes(publicKey)) {
      mentions.push(publicKey);
    }
  }
  if (mentions.length > BUZZ_MENTION_MAX_COUNT) {
    throw new Error(`Buzz messages support at most ${BUZZ_MENTION_MAX_COUNT} mentions`);
  }
  const missingPublicKeys = mentions.filter((publicKey) => !members.has(publicKey));
  if (missingPublicKeys.length > 0) {
    throw new Error(
      `Buzz mentioned public key is not a current room member: ${missingPublicKeys.join(", ")}`,
    );
  }

  const namesToPublicKeys = new Map<string, string[]>();
  for (const member of members.values()) {
    if (!member.displayName) {
      continue;
    }
    const name = asciiLowercase(member.displayName);
    const matches = namesToPublicKeys.get(name) ?? [];
    matches.push(member.publicKey);
    namesToPublicKeys.set(name, matches);
  }
  const names = extractMentionNames(
    stripped,
    [...members.values()]
      .map((member) => member.displayName)
      .filter((name): name is string => Boolean(name)),
  );
  if (hasAtMentionCandidate(stripped) && names.length === 0 && explicitPublicKeys.length === 0) {
    throw new Error(
      "Buzz mention does not match a current room member; use nostr:npub... for an explicit identity",
    );
  }
  for (const name of names) {
    const matches = namesToPublicKeys.get(name) ?? [];
    if (matches.length === 0) {
      if (explicitPublicKeys.length > 0) {
        continue;
      }
      throw new Error(
        `Buzz mention "@${name}" does not match a current room member; use nostr:npub... for an explicit identity`,
      );
    }
    if (matches.length > 1) {
      if (explicitPublicKeys.length > 0) {
        continue;
      }
      const visibleCandidates = matches
        .slice(0, BUZZ_AMBIGUITY_CANDIDATE_LIMIT)
        .map((publicKey) => nip19.npubEncode(publicKey))
        .join(", ");
      const hiddenCandidateCount = matches.length - BUZZ_AMBIGUITY_CANDIDATE_LIMIT;
      const candidateSuffix = hiddenCandidateCount > 0 ? `, and ${hiddenCandidateCount} more` : "";
      throw new Error(
        `Buzz mention "@${name}" is ambiguous; candidates: ${visibleCandidates}${candidateSuffix}. Use nostr:npub... for an explicit identity`,
      );
    }
    const publicKey = matches[0];
    if (!publicKey) {
      throw new Error("Buzz mention resolution lost its unique room member");
    }
    if (publicKey !== senderPublicKey && !mentions.includes(publicKey)) {
      if (mentions.length >= BUZZ_MENTION_MAX_COUNT) {
        throw new Error(`Buzz messages support at most ${BUZZ_MENTION_MAX_COUNT} mentions`);
      }
      mentions.push(publicKey);
    }
  }
  return mentions;
}
