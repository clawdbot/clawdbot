import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  changedDraftPayload,
  draftPayload,
  rebaseWorkboardDraft,
  removeCardAndReferences,
  replaceCard,
  resetDraftState,
  selectedWorkboardBoardParams,
} from "./card-state.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardPayload, normalizeCardsPayload } from "./normalization.ts";
import {
  getWorkboardState,
  invalidateWorkboardLoads,
  resetWorkboardLifecycleTaskConfirmations,
  setWorkboardLifecycleTaskRefreshFailed,
  workboardHasActiveWrites,
  workboardMutationsReady,
  type WorkboardHost,
} from "./runtime.ts";
import { applyTaskSummariesToState, listWorkboardTasks } from "./task-links.ts";
import type { WorkboardDispatchSummary, WorkboardStatus } from "./types.ts";

function normalizeDispatchSummary(value: unknown): WorkboardDispatchSummary {
  const countArray = (key: string) =>
    isRecord(value) && Array.isArray(value[key]) ? value[key].length : 0;
  return {
    started: countArray("started"),
    failures: countArray("startFailures"),
    promoted: countArray("promoted"),
    blocked: countArray("blocked"),
    reclaimed: countArray("reclaimed"),
    orchestrated: countArray("orchestrated"),
  };
}

async function createWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    !state.draftTitle.trim() ||
    state.dispatching ||
    state.draftSaving
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.draftSaving = true;
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.create", {
      ...draftPayload(state),
      ...selectedWorkboardBoardParams(state),
    });
    replaceCard(state, normalizeCardPayload(payload));
    resetDraftState(state);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.draftSaving = false;
    state.loading = false;
    params.requestUpdate?.();
  }
}

export async function saveWorkboardCardDraft(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!state.editingCardId) {
    await createWorkboardCard(params);
    return;
  }
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    !state.draftTitle.trim() ||
    state.dispatching ||
    state.draftSaving ||
    state.busyCardIds.has(state.editingCardId)
  ) {
    return;
  }
  const cardId = state.editingCardId;
  const base = state.editingCardBase;
  if (!base || base.id !== cardId) {
    state.error = "This card changed before editing began. Cancel and reopen it to continue.";
    params.requestUpdate?.();
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.draftSaving = true;
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    const patch = changedDraftPayload(state);
    if (Object.keys(patch).length === 0) {
      resetDraftState(state);
      return;
    }
    const payload = await params.client.request("workboard.cards.update", {
      id: cardId,
      expectedUpdatedAt: base.updatedAt,
      patch,
    });
    replaceCard(state, normalizeCardPayload(payload));
    resetDraftState(state);
  } catch (error) {
    if (
      isGatewayRequestError(error) &&
      error.code === "workboard_conflict" &&
      isRecord(error.details) &&
      error.details.type === "workboard_card_conflict"
    ) {
      const current = normalizeCardPayload(error.details);
      replaceCard(state, current);
      rebaseWorkboardDraft(state, current);
      state.error = `${error.message} Your unsaved edits remain in the form.`;
    } else {
      state.error = formatError(error);
    }
  } finally {
    state.draftSaving = false;
    state.loading = false;
    params.requestUpdate?.();
  }
}

export async function addWorkboardCardComment(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId?: string;
  body?: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const cardId = params.cardId ?? state.editingCardId;
  const draftField = params.body === undefined ? "draftCommentBody" : "detailCommentBody";
  const submittedDraft = params.body ?? state.draftCommentBody;
  const body = submittedDraft.trim();
  if (
    !cardId ||
    !params.client ||
    !workboardMutationsReady(state) ||
    !body ||
    state.dispatching ||
    state.draftSaving ||
    state.busyCardIds.has(cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.comment", {
      id: cardId,
      body,
    });
    const current = normalizeCardPayload(payload);
    replaceCard(state, current);
    if (state.editingCardId === cardId && state.editingCardBase?.id === cardId) {
      rebaseWorkboardDraft(state, current);
    }
    // The operator may type another note or switch cards while this request settles.
    // Clear only the draft that submitted it, preserving the raw text for comparison.
    const draftCardId =
      draftField === "draftCommentBody" ? state.editingCardId : state.detailCardId;
    if (draftCardId === cardId && state[draftField] === submittedDraft) {
      state[draftField] = "";
    }
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(cardId);
    params.requestUpdate?.();
  }
}

export async function moveWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  status: WorkboardStatus;
  position: number;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.move", {
      id: params.cardId,
      status: params.status,
      position: params.position,
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.cardId);
    if (state.draggedCardId === params.cardId) {
      state.draggedCardId = null;
    }
    params.requestUpdate?.();
  }
}

export async function deleteWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    await params.client.request("workboard.cards.delete", { id: params.cardId });
    state.cards = removeCardAndReferences(state.cards, params.cardId);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.cardId);
    params.requestUpdate?.();
  }
}

export async function archiveWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  archived?: boolean;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.archive", {
      id: params.cardId,
      archived: params.archived ?? true,
    });
    replaceCard(state, normalizeCardPayload(payload));
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(params.cardId);
    params.requestUpdate?.();
  }
}

export async function dispatchWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    workboardHasActiveWrites(state)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.dispatching = true;
  state.error = null;
  state.lastDispatchSummary = null;
  params.requestUpdate?.();
  try {
    const dispatchResult = await params.client.request(
      "workboard.cards.dispatch",
      selectedWorkboardBoardParams(state),
    );
    const payload = await params.client.request("workboard.cards.list", {});
    const normalized = normalizeCardsPayload(payload);
    state.cards = normalized.cards;
    state.statuses = normalized.statuses;
    state.lastDispatchSummary = normalizeDispatchSummary(dispatchResult);
    state.tasksByCardId = new Map();
    resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
    try {
      applyTaskSummariesToState(state, await listWorkboardTasks(params.client));
      setWorkboardLifecycleTaskRefreshFailed(state, false, { host: params.host });
      state.lifecycleTaskRefreshError = null;
      state.lastRefreshError = null;
    } catch (error) {
      setWorkboardLifecycleTaskRefreshFailed(state, true, {
        host: params.host,
        requestUpdate: params.requestUpdate,
      });
      state.lastRefreshError = formatError(error);
    }
    // A teardown may have invalidated this in-flight dispatch. Keep its cached
    // result reload-required so reconnect cannot treat an old completion as canonical.
    state.loaded = workboardMutationsReady(state);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.dispatching = false;
    params.requestUpdate?.();
  }
}
