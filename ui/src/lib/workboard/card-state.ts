import type { GatewaySessionRow } from "../../api/types.ts";
import type {
  WorkboardCard,
  WorkboardDependencyState,
  WorkboardMetadata,
  WorkboardStaleState,
  WorkboardUiState,
} from "./types.ts";

const WORKBOARD_STALE_SESSION_MS = 30 * 60 * 1000;

export function replaceCard(state: WorkboardUiState, card: WorkboardCard) {
  const next = state.cards.filter((existing) => existing.id !== card.id);
  next.push(card);
  state.cards = next.toSorted((left, right) => left.position - right.position);
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

export function resetDraftState(state: WorkboardUiState) {
  const resolveStaleEdit = state.loaded && state.mutationReadiness === "stale_edit_draft";
  state.draftOpen = false;
  state.editingCardId = null;
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

export function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
