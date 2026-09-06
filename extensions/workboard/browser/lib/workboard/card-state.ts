import { normalizeNullableString as normalizeString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewaySessionRow } from "../../api/types.ts";
import type {
  WorkboardCard,
  WorkboardDependencyState,
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
