import { normalizeSessionKeyForUiComparison } from "../sessions/session-key.ts";
import { isActiveWorkboardCard } from "./card-state.ts";
import type { WorkboardCard } from "./types.ts";

// These reserved names exist per agent; a saved card key alone cannot identify one.
export function isReservedSessionKey(sessionKey: string): boolean {
  const key = normalizeSessionKeyForUiComparison(sessionKey);
  return key === "global" || key === "unknown";
}

export function workboardSessionLookupKeys(sessionKey: string): string[] {
  const key = normalizeSessionKeyForUiComparison(sessionKey);
  if (!key) {
    return [];
  }
  // Only a stored agentless Workboard link is provisional. Never collapse two
  // explicit agent identities just because their local session tails agree.
  const suffixIndex = key.lastIndexOf(":subagent:workboard-");
  return suffixIndex < 0 ? [key] : [key, key.slice(suffixIndex + 1)];
}

export function workboardSessionKeyMatches(
  candidate: string | undefined,
  linkedSessionKey: string,
): boolean {
  return Boolean(
    candidate &&
    workboardSessionLookupKeys(candidate).includes(
      normalizeSessionKeyForUiComparison(linkedSessionKey),
    ),
  );
}

function cardSessionKeys(card: WorkboardCard): string[] {
  return [
    card.sessionKey,
    card.execution?.sessionKey,
    ...(card.metadata?.attempts?.map((attempt) => attempt.sessionKey) ?? []),
    ...(card.events?.map((event) => event.sessionKey) ?? []),
  ]
    .filter((key): key is string => typeof key === "string")
    .map(normalizeSessionKeyForUiComparison)
    .filter(Boolean);
}

function compareSessionCards(left: WorkboardCard, right: WorkboardCard): number {
  return (
    Number(!isActiveWorkboardCard(left)) - Number(!isActiveWorkboardCard(right)) ||
    right.updatedAt - left.updatedAt
  );
}

function indexWorkboardSessionCards(cards: readonly WorkboardCard[]): Map<string, WorkboardCard> {
  const index = new Map<string, WorkboardCard>();
  for (const card of cards) {
    for (const key of cardSessionKeys(card)) {
      const previous = index.get(key);
      if (!previous || compareSessionCards(card, previous) < 0) {
        index.set(key, card);
      }
    }
  }
  return index;
}

export function findWorkboardSessionCard(
  cards: readonly WorkboardCard[],
  sessionKey: string,
): WorkboardCard | null {
  if (isReservedSessionKey(sessionKey)) {
    return null;
  }
  // A local session tail cannot establish its agent owner. Provisional link
  // resolution belongs to session-resolution; this lookup needs recorded identity.
  const key = normalizeSessionKeyForUiComparison(sessionKey);
  return indexWorkboardSessionCards(cards).get(key) ?? null;
}
