import { normalizeNullableString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type {
  WorkboardCard,
  WorkboardCardRemoval,
  WorkboardDependencyState,
  WorkboardLink,
  WorkboardMetadata,
  WorkboardStaleState,
  WorkboardStatus,
  WorkboardTemplateId,
  WorkboardUiState,
} from "./types.ts";

export { normalizeString };

const WORKBOARD_STALE_SESSION_MS = 30 * 60 * 1000;

export function isActiveWorkboardCard(card: WorkboardCard): boolean {
  return !card.metadata?.archivedAt;
}

export function nextWorkboardCardPosition(
  cards: readonly WorkboardCard[],
  card: WorkboardCard,
  status: WorkboardStatus,
): number {
  const boardId = card.metadata?.automation?.boardId?.trim() || "default";
  const positions = cards
    .filter(
      (candidate) =>
        candidate.id !== card.id &&
        candidate.status === status &&
        (candidate.metadata?.automation?.boardId?.trim() || "default") === boardId,
    )
    .map((candidate) => candidate.position);
  // Archived cards still own their persisted positions in the canonical store.
  return Math.max(0, ...positions) + 1000;
}

export function selectedWorkboardBoardParams(
  state: Pick<WorkboardUiState, "boards" | "boardFilter">,
): { boardId?: string } {
  const boardId = state.boards.find((board) => board.id === state.boardFilter)?.id;
  return boardId ? { boardId } : {};
}

export function replaceCard(state: WorkboardUiState, card: WorkboardCard) {
  updatePendingCardRemovals(state.pendingCardRemovals, [card]);
  const next = state.cards.filter((existing) => existing.id !== card.id);
  next.push(card);
  state.cards = applyPendingCardRemovals(next, state.pendingCardRemovals);
}

function parentDependencyIds(card: WorkboardCard): string[] {
  const ids: string[] = [];
  for (const link of card.metadata?.links ?? []) {
    const id = link.type === "parent" ? link.targetCardId?.trim() : "";
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export function getWorkboardDependencyState(
  card: WorkboardCard,
  cards: readonly WorkboardCard[],
): WorkboardDependencyState {
  const cardsById = new Map(cards.map((entry) => [entry.id, entry]));
  const parents = parentDependencyIds(card).map((id) => {
    const parent = cardsById.get(id);
    return {
      id,
      title: parent?.title ?? id,
      status: parent?.status,
      done: parent?.status === "done",
      missing: !parent,
    };
  });
  return {
    parents,
    blockedParents: parents.filter((parent) => !parent.done),
  };
}

export function removeCardAndReferences(
  cards: readonly WorkboardCard[],
  cardId: string,
): WorkboardCard[] {
  const nextCards: WorkboardCard[] = [];
  for (const card of cards) {
    if (card.id === cardId) {
      continue;
    }
    const links = card.metadata?.links;
    if (!links?.some((link) => link.targetCardId === cardId)) {
      nextCards.push(card);
      continue;
    }
    const nextLinks = links.filter((link) => link.targetCardId !== cardId);
    const metadata: WorkboardMetadata = { ...card.metadata, links: nextLinks };
    if (nextLinks.length === 0) {
      delete metadata.links;
    }
    nextCards.push(
      Object.keys(metadata).length ? { ...card, metadata } : { ...card, metadata: undefined },
    );
  }
  return nextCards;
}

export function applyPendingCardRemovals(
  cards: readonly WorkboardCard[],
  pendingRemovals: ReadonlyMap<string, WorkboardCardRemoval>,
): WorkboardCard[] {
  let nextCards = [...cards];
  for (const cardId of pendingRemovals.keys()) {
    nextCards = removeCardAndReferences(nextCards, cardId);
  }
  return nextCards.toSorted((left, right) => left.position - right.position);
}

function appendMissingLinks(
  currentLinks: readonly WorkboardLink[],
  linksToAppend: readonly WorkboardLink[],
): WorkboardLink[] {
  const nextLinks = [...currentLinks];
  for (const link of linksToAppend) {
    if (!nextLinks.some((current) => current.id === link.id)) {
      nextLinks.push(link);
    }
  }
  return nextLinks;
}

function restorePendingIncomingLinks(
  card: WorkboardCard,
  pendingRemovals: ReadonlyMap<string, WorkboardCardRemoval>,
): WorkboardCard {
  const linksToRestore = [...pendingRemovals.values()].flatMap((removal) =>
    removal.incomingLinks
      .filter((incoming) => incoming.cardId === card.id)
      .flatMap((incoming) => incoming.links),
  );
  const currentLinks = card.metadata?.links ?? [];
  const nextLinks = appendMissingLinks(currentLinks, linksToRestore);
  if (nextLinks.length === currentLinks.length) {
    return card;
  }
  return { ...card, metadata: { ...card.metadata, links: nextLinks } };
}

function updatePendingCardRemovalForCard(
  pendingRemovals: Map<string, WorkboardCardRemoval>,
  card: WorkboardCard,
): void {
  for (const [pendingCardId, removal] of pendingRemovals) {
    let nextRemoval = removal;
    if (pendingCardId === card.id && removal.card !== card) {
      nextRemoval = { ...nextRemoval, card };
    }
    if (card.id !== pendingCardId) {
      const nextIncomingLinks = removal.incomingLinks.filter(
        (incoming) => incoming.cardId !== card.id,
      );
      const links = card.metadata?.links?.filter((link) => link.targetCardId === pendingCardId);
      if (links?.length) {
        nextIncomingLinks.push({ cardId: card.id, links: [...links] });
      }
      nextRemoval = { ...nextRemoval, incomingLinks: nextIncomingLinks };
    }
    if (nextRemoval !== removal) {
      pendingRemovals.set(pendingCardId, nextRemoval);
    }
  }
}

export function updatePendingCardRemovals(
  pendingRemovals: Map<string, WorkboardCardRemoval>,
  cards: readonly WorkboardCard[],
): void {
  for (const card of cards) {
    updatePendingCardRemovalForCard(pendingRemovals, card);
  }
}

function withoutLinksToCards(card: WorkboardCard, cardIds: ReadonlySet<string>): WorkboardCard {
  const links = card.metadata?.links;
  if (!links) {
    return card;
  }
  const nextLinks = links.filter(
    (link) => link.targetCardId === undefined || !cardIds.has(link.targetCardId),
  );
  if (nextLinks.length === links.length) {
    return card;
  }
  const metadata: WorkboardMetadata = { ...card.metadata, links: nextLinks };
  if (nextLinks.length === 0) {
    delete metadata.links;
  }
  return Object.keys(metadata).length ? { ...card, metadata } : { ...card, metadata: undefined };
}

export function discardPendingLinksToCard(
  pendingRemovals: Map<string, WorkboardCardRemoval>,
  cardId: string,
) {
  const deletedCardIds = new Set([cardId]);
  for (const [pendingCardId, removal] of pendingRemovals) {
    if (!removal.card) {
      continue;
    }
    const card = withoutLinksToCards(removal.card, deletedCardIds);
    if (card !== removal.card) {
      pendingRemovals.set(pendingCardId, { ...removal, card });
    }
  }
}

export function captureCardRemoval(
  cards: readonly WorkboardCard[],
  cardId: string,
  pendingRemovals: ReadonlyMap<string, WorkboardCardRemoval> = new Map(),
): WorkboardCardRemoval {
  const cardIndex = cards.findIndex((card) => card.id === cardId);
  return {
    cardId,
    card:
      cardIndex >= 0 && cards[cardIndex]
        ? restorePendingIncomingLinks(cards[cardIndex], pendingRemovals)
        : undefined,
    incomingLinks: [
      ...cards.flatMap((card) => {
        if (card.id === cardId) {
          return [];
        }
        const links = card.metadata?.links?.filter((link) => link.targetCardId === cardId);
        return links?.length ? [{ cardId: card.id, links: [...links] }] : [];
      }),
      ...[...pendingRemovals.values()].flatMap((removal) => {
        const card = removal.card;
        if (!card || card.id === cardId) {
          return [];
        }
        const links = card.metadata?.links?.filter((link) => link.targetCardId === cardId);
        return links?.length ? [{ cardId: card.id, links: [...links] }] : [];
      }),
    ],
  };
}

export function restoreCardRemoval(
  cards: readonly WorkboardCard[],
  removal: WorkboardCardRemoval,
  pendingRemovals: ReadonlyMap<string, WorkboardCardRemoval> = new Map(),
): WorkboardCard[] {
  const nextCards = [...cards];
  const pendingCardIds = new Set(pendingRemovals.keys());
  const restoredCard = removal.card ? withoutLinksToCards(removal.card, pendingCardIds) : undefined;
  if (restoredCard && !nextCards.some((card) => card.id === removal.cardId)) {
    nextCards.push(restoredCard);
  }

  for (const incoming of removal.incomingLinks) {
    if (pendingRemovals.has(incoming.cardId)) {
      continue;
    }
    const cardIndex = nextCards.findIndex((card) => card.id === incoming.cardId);
    if (cardIndex < 0) {
      continue;
    }
    const card = nextCards[cardIndex];
    if (!card) {
      continue;
    }
    const currentLinks = card.metadata?.links ?? [];
    const nextLinks = appendMissingLinks(currentLinks, incoming.links);
    if (nextLinks.length === currentLinks.length) {
      continue;
    }
    const metadata: WorkboardMetadata = {
      ...card.metadata,
      links: nextLinks,
    };
    nextCards[cardIndex] = { ...card, metadata };
  }

  return nextCards.toSorted((left, right) => left.position - right.position);
}

export function resetDraftState(state: WorkboardUiState) {
  const resolveStaleEdit = state.loaded && state.mutationReadiness === "stale_edit_draft";
  state.draftOpen = false;
  state.editingCardId = null;
  state.editingCardBase = null;
  state.draftTitle = "";
  state.draftNotes = "";
  state.draftStatus = "todo";
  state.draftPriority = "normal";
  state.draftLabels = "";
  state.draftAgentId = "";
  state.draftSessionKey = "";
  state.draftTemplateId = "";
  state.draftCommentBody = "";
  if (resolveStaleEdit) {
    state.mutationReadiness = "ready";
  }
}

function normalizeDraftLabels(value: string): string[] {
  const labels: string[] = [];
  for (const label of value.split(",")) {
    const trimmed = label.trim();
    if (trimmed && !labels.includes(trimmed)) {
      labels.push(trimmed);
    }
    if (labels.length >= 12) {
      break;
    }
  }
  return labels;
}

export function draftPayload(state: WorkboardUiState) {
  return {
    title: state.draftTitle,
    notes: state.draftNotes,
    status: state.draftStatus,
    priority: state.draftPriority,
    labels: normalizeDraftLabels(state.draftLabels),
    agentId: state.draftAgentId,
    sessionKey: state.draftSessionKey,
    ...(state.draftTemplateId ? { templateId: state.draftTemplateId } : {}),
  };
}

type WorkboardCardDraft = {
  title: string;
  notes: string;
  status: WorkboardStatus;
  priority: WorkboardCard["priority"];
  labels: string[];
  agentId: string;
  sessionKey: string;
  templateId: WorkboardTemplateId | "";
};

function cardDraftPayload(card: WorkboardCard): WorkboardCardDraft {
  return {
    title: card.title,
    notes: card.notes ?? "",
    status: card.status,
    priority: card.priority,
    labels: card.labels,
    agentId: card.agentId ?? "",
    sessionKey: workboardCardSessionKey(card) ?? "",
    templateId: card.metadata?.templateId ?? "",
  };
}

export function changedDraftPayload(state: WorkboardUiState): Record<string, unknown> {
  const base = state.editingCardBase;
  if (!base) {
    return {};
  }
  const draft: Record<string, unknown> = {
    ...draftPayload(state),
    templateId: state.draftTemplateId,
  };
  const previous: Record<string, unknown> = cardDraftPayload(base);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft)) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(previous[key])) {
      patch[key] = key === "templateId" && draft[key] === "" ? null : draft[key];
    }
  }
  return patch;
}

export function rebaseWorkboardDraft(state: WorkboardUiState, current: WorkboardCard): void {
  const changed = new Set(Object.keys(changedDraftPayload(state)));
  const next = cardDraftPayload(current);
  if (!changed.has("title")) {
    state.draftTitle = next.title;
  }
  if (!changed.has("notes")) {
    state.draftNotes = next.notes;
  }
  if (!changed.has("status")) {
    state.draftStatus = next.status;
  }
  if (!changed.has("priority")) {
    state.draftPriority = next.priority;
  }
  if (!changed.has("labels")) {
    state.draftLabels = next.labels.join(", ");
  }
  if (!changed.has("agentId")) {
    state.draftAgentId = next.agentId;
  }
  if (!changed.has("sessionKey")) {
    state.draftSessionKey = next.sessionKey;
  }
  if (!changed.has("templateId")) {
    state.draftTemplateId = next.templateId;
  }
  state.editingCardBase = current;
}

export function isFailedSessionStatus(status: GatewaySessionRow["status"]): boolean {
  return status === "failed" || status === "killed" || status === "timeout";
}

export function staleSessionState(session: GatewaySessionRow): WorkboardStaleState | undefined {
  if (session.status !== "running") {
    return undefined;
  }
  if (session.hasActiveRun !== false) {
    return undefined;
  }
  if (
    typeof session.updatedAt !== "number" ||
    Date.now() - session.updatedAt < WORKBOARD_STALE_SESSION_MS
  ) {
    return undefined;
  }
  return {
    detectedAt: Date.now(),
    lastSessionUpdatedAt: session.updatedAt,
    reason: "Linked session has not reported recent activity.",
  };
}

export function workboardCardSessionKey(card: WorkboardCard): string | undefined {
  return card.sessionKey ?? card.execution?.sessionKey;
}

export function workboardCardRunId(card: WorkboardCard): string | undefined {
  return card.runId ?? card.execution?.runId;
}
