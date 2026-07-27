import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginApi } from "../api.js";
import { cardSessionKey } from "./store-card-helpers.js";
import { WorkboardStore } from "./store.js";

const WORKBOARD_MARKER_PREFIX = "Workboard: ";

// Marker state is deliberately plugin-local and non-serialized. Never infer
// idempotence by rewriting user-visible text.
const workboardMarkerSuppressedPayloads = new WeakSet<object>();
const workboardMarkedPayloads = new WeakSet<object>();

export type WorkboardMarkerPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  isReasoning?: boolean;
};

/** Marks a Workboard-owned payload as an exact-format reply. */
export function omitWorkboardMarker<T extends WorkboardMarkerPayload>(payload: T): T {
  workboardMarkerSuppressedPayloads.add(payload);
  return payload;
}

function hasVisibleContent(payload: WorkboardMarkerPayload): boolean {
  return Boolean(
    payload.text?.trim() ||
    payload.mediaUrl?.trim() ||
    payload.mediaUrls?.some((url) => typeof url === "string" && url.trim()),
  );
}

function isSilentText(text: string): boolean {
  const normalized = text.trim();
  return normalized === "NO_REPLY" || normalized === "HEARTBEAT_OK";
}

function isActiveCard(card: WorkboardCard, sessionKey: string, now: number): boolean {
  const claim = card.metadata?.claim;
  return Boolean(
    card.status === "running" &&
    claim &&
    cardSessionKey(card) === sessionKey &&
    (!claim.expiresAt || claim.expiresAt > now),
  );
}

/** Selects one deterministic primary card when a session has multiple active claims. */
export function selectPrimaryWorkboardCard(
  cards: readonly WorkboardCard[],
  sessionKey: string,
  now = Date.now(),
): WorkboardCard | undefined {
  return cards
    .filter((card) => isActiveCard(card, sessionKey, now))
    .toSorted((left, right) => {
      const leftClaimedAt = left.metadata?.claim?.claimedAt ?? 0;
      const rightClaimedAt = right.metadata?.claim?.claimedAt ?? 0;
      return rightClaimedAt - leftClaimedAt || right.updatedAt - left.updatedAt;
    })[0];
}

/** Adds a privacy-safe current-card ID marker once at the final user-visible reply boundary. */
export function addWorkboardMarker<T extends WorkboardMarkerPayload>(
  payload: T,
  card: WorkboardCard | undefined,
): T {
  if (
    !card ||
    workboardMarkerSuppressedPayloads.has(payload) ||
    workboardMarkedPayloads.has(payload) ||
    payload.isReasoning ||
    !hasVisibleContent(payload)
  ) {
    return payload;
  }
  const marker = `${WORKBOARD_MARKER_PREFIX}${card.id}`;
  const text = payload.text ?? "";
  if (isSilentText(text)) {
    return payload;
  }
  const markedPayload = {
    ...payload,
    text: text ? `${marker}\n${text}` : marker,
  };
  workboardMarkedPayloads.add(markedPayload);
  return markedPayload;
}

export function registerWorkboardReplyMarker(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
}): void {
  params.api.on("reply_payload_sending", async (event, ctx) => {
    const sessionKey = event.sessionKey ?? ctx.sessionKey;
    if (!sessionKey) {
      return undefined;
    }
    const card = selectPrimaryWorkboardCard(await params.store.list(), sessionKey);
    const payload = addWorkboardMarker(event.payload, card);
    return payload === event.payload ? undefined : { payload };
  });
}
