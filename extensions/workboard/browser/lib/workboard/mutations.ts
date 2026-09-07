import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isGatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  encodeWorkboardAttachment,
  hasWorkboardStagedAttachmentBusy,
  WORKBOARD_MAX_CARD_ATTACHMENTS,
  workboardAttachmentMimeType,
} from "./attachments.ts";
import {
  changedDraftPayload,
  draftPayload,
  rebaseWorkboardDraft,
  removeCardAndReferences,
  replaceCard,
  resetDraftState,
  selectedWorkboardBoardParams,
  workboardCardSessionKey,
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
import type {
  WorkboardAttachment,
  WorkboardCard,
  WorkboardDispatchSummary,
  WorkboardStagedAttachment,
  WorkboardStatus,
} from "./types.ts";

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

function attachmentReadResult(
  payload: unknown,
  fallback: WorkboardAttachment,
): { attachment: WorkboardAttachment; contentBase64: string } {
  if (!isRecord(payload) || typeof payload.contentBase64 !== "string") {
    throw new Error("workboard attachment response did not include file content");
  }
  return {
    attachment: fallback,
    contentBase64: payload.contentBase64,
  };
}

function workboardCardDraftFieldValue(card: WorkboardCard, key: string): unknown {
  switch (key) {
    case "title":
      return card.title;
    case "notes":
      return card.notes ?? "";
    case "status":
      return card.status;
    case "priority":
      return card.priority;
    case "labels":
      return card.labels;
    case "agentId":
      return card.agentId ?? "";
    case "sessionKey":
      return workboardCardSessionKey(card) ?? "";
    case "templateId":
      return card.metadata?.templateId ?? "";
    default:
      return undefined;
  }
}

function hasOverlappingWorkboardDraftChange(
  base: WorkboardCard,
  current: WorkboardCard,
  patch: Record<string, unknown>,
): boolean {
  return Object.keys(patch).some(
    (key) =>
      JSON.stringify(workboardCardDraftFieldValue(base, key)) !==
      JSON.stringify(workboardCardDraftFieldValue(current, key)),
  );
}

function isCurrentWorkboardAttachment(
  state: ReturnType<typeof getWorkboardState>,
  attachment: WorkboardAttachment,
): boolean {
  return (
    state.detailCardId === attachment.cardId &&
    state.cards.some(
      (card) =>
        card.id === attachment.cardId &&
        (card.metadata?.attachments ?? []).some((entry) => entry.id === attachment.id),
    )
  );
}

// Gateway response errors prove the server rejected the request; local transport/deadline errors do not.
// A transport failure can leave an attachments.add operation in flight after the client stops waiting.
function isAuthoritativeWorkboardAttachmentFailure(error: unknown): boolean {
  return isGatewayRequestError(error);
}

async function reconcileWorkboardAttachmentDelete(params: {
  client: GatewayBrowserClient;
  cardId: string;
  attachmentId: string;
}): Promise<WorkboardCard | null> {
  try {
    const payload = await params.client.request("workboard.cards.attachments.list", {
      id: params.cardId,
    });
    const card = normalizeCardPayload(payload);
    return (card.metadata?.attachments ?? []).some(
      (attachment) => attachment.id === params.attachmentId,
    )
      ? null
      : card;
  } catch {
    return null;
  }
}

function focusWorkboardAttachmentAfterDelete(
  host: WorkboardHost,
  cardId: string,
  trigger: HTMLButtonElement | null | undefined,
  previousActive: Element | null,
) {
  if (!trigger) {
    return;
  }
  const shouldPreserveFocus =
    previousActive !== null &&
    previousActive !== trigger &&
    previousActive !== trigger.ownerDocument.body;
  const previousAttachmentId = previousActive?.getAttribute("data-workboard-attachment-id");
  const previousAttachmentAction = previousActive?.getAttribute("data-workboard-attachment-action");
  queueMicrotask(() => {
    if (getWorkboardState(host).detailCardId !== cardId) {
      return;
    }
    const drawer = trigger.ownerDocument.getElementById("workboard-card-detail-drawer");
    if (shouldPreserveFocus) {
      if (previousAttachmentId && previousAttachmentAction) {
        const matchingAction = Array.from(
          drawer?.querySelectorAll<HTMLButtonElement>(
            "[data-workboard-attachment-id][data-workboard-attachment-action]:not([disabled])",
          ) ?? [],
        ).find(
          (button) =>
            button.getAttribute("data-workboard-attachment-id") === previousAttachmentId &&
            button.getAttribute("data-workboard-attachment-action") === previousAttachmentAction,
        );
        matchingAction?.focus();
      }
      return;
    }
    const active = trigger.ownerDocument.activeElement;
    if (active !== trigger && active !== trigger.ownerDocument.body) {
      return;
    }
    const attachmentAction = drawer?.querySelector<HTMLButtonElement>(
      ".workboard-attachment-details__actions button:not([disabled])",
    );
    const fallback =
      drawer?.querySelector<HTMLButtonElement>(
        ".workboard-detail__header button:not([disabled])",
      ) ?? drawer?.querySelector<HTMLButtonElement>("button:not([disabled])");
    (attachmentAction ?? fallback)?.focus();
  });
}

function clearDeletedWorkboardAttachmentPreview(
  state: ReturnType<typeof getWorkboardState>,
  attachmentId: string,
  requestIdAtStart: number,
) {
  if (state.attachmentPreview?.attachment.id !== attachmentId) {
    return;
  }
  state.attachmentPreview = null;
  if (state.attachmentPreviewRequestId === requestIdAtStart) {
    state.attachmentPreviewRequestId += 1;
    state.attachmentPreviewTrigger = null;
  }
}

export async function readWorkboardAttachment(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  attachment: WorkboardAttachment;
  onError?: (error: unknown) => void;
  requestUpdate?: () => void;
}): Promise<{ attachment: WorkboardAttachment; contentBase64: string } | null> {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.attachmentBusyIds.has(params.attachment.id)
  ) {
    return null;
  }
  state.attachmentBusyIds.add(params.attachment.id);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.attachments.get", {
      id: params.attachment.id,
    });
    return attachmentReadResult(payload, params.attachment);
  } catch (error) {
    if (params.onError) {
      params.onError(error);
    } else {
      state.error = formatError(error);
    }
    return null;
  } finally {
    state.attachmentBusyIds.delete(params.attachment.id);
    params.requestUpdate?.();
  }
}

export async function inspectWorkboardAttachment(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  attachment: WorkboardAttachment;
  trigger?: HTMLButtonElement | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const requestId = state.attachmentPreviewRequestId + 1;
  state.attachmentPreviewRequestId = requestId;
  state.attachmentPreviewTrigger = params.trigger ?? null;
  const result = await readWorkboardAttachment({
    host: params.host,
    client: params.client,
    attachment: params.attachment,
    requestUpdate: params.requestUpdate,
    onError: (error) => {
      if (
        state.attachmentPreviewRequestId === requestId &&
        isCurrentWorkboardAttachment(state, params.attachment)
      ) {
        state.error = formatError(error);
      }
    },
  });
  if (!result) {
    return;
  }
  if (
    state.attachmentPreviewRequestId === requestId &&
    isCurrentWorkboardAttachment(state, params.attachment)
  ) {
    state.attachmentPreview = result;
    params.requestUpdate?.();
  }
}

export async function downloadWorkboardAttachment(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  attachment: WorkboardAttachment;
  requestUpdate?: () => void;
}) {
  const result = await readWorkboardAttachment(params);
  if (!result) {
    return;
  }
  const bytes = Uint8Array.from(atob(result.contentBase64), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(
    new Blob([bytes], { type: workboardAttachmentMimeType(result.attachment) }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = result.attachment.fileName;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function deleteWorkboardAttachment(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  attachmentId: string;
  trigger?: HTMLButtonElement | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.attachmentBusyIds.has(params.attachmentId)
  ) {
    return;
  }
  const previewRequestIdAtStart = state.attachmentPreviewRequestId;
  invalidateWorkboardLoads(params.host);
  state.attachmentBusyIds.add(params.attachmentId);
  state.error = null;
  params.requestUpdate?.();
  let deleted = false;
  try {
    const payload = await params.client.request("workboard.cards.attachments.delete", {
      id: params.cardId,
      attachmentId: params.attachmentId,
    });
    replaceCard(state, normalizeCardPayload(payload));
    deleted = true;
    clearDeletedWorkboardAttachmentPreview(state, params.attachmentId, previewRequestIdAtStart);
  } catch (error) {
    const reconciled = await reconcileWorkboardAttachmentDelete({
      client: params.client,
      cardId: params.cardId,
      attachmentId: params.attachmentId,
    });
    if (reconciled) {
      replaceCard(state, reconciled);
      deleted = true;
      clearDeletedWorkboardAttachmentPreview(state, params.attachmentId, previewRequestIdAtStart);
    } else {
      state.error = formatError(error);
    }
  } finally {
    const previousActive = params.trigger?.ownerDocument.activeElement ?? null;
    state.attachmentBusyIds.delete(params.attachmentId);
    params.requestUpdate?.();
    if (deleted) {
      focusWorkboardAttachmentAfterDelete(
        params.host,
        params.cardId,
        params.trigger,
        previousActive,
      );
    }
  }
}

export function removeWorkboardStagedAttachment(params: {
  host: WorkboardHost;
  staged: WorkboardStagedAttachment;
  trigger?: HTMLButtonElement | null;
  onRemoved?: (previousActive: Element | null) => void;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (!state.draftAttachments.some((entry) => entry.id === params.staged.id)) {
    return;
  }
  const previousActive = params.trigger?.ownerDocument.activeElement ?? null;
  state.draftAttachments = state.draftAttachments.filter((entry) => entry.id !== params.staged.id);
  params.requestUpdate?.();
  params.onRemoved?.(previousActive);
}

export async function saveWorkboardCardDraft(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const cardId = state.editingCardId;
  const base = cardId ? state.editingCardBase : null;
  const stagedAttachments = [...state.draftAttachments];
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    !state.draftTitle.trim() ||
    state.dispatching ||
    state.draftSaving ||
    hasWorkboardStagedAttachmentBusy(state.attachmentBusyIds) ||
    (cardId && state.busyCardIds.has(cardId))
  ) {
    return;
  }
  if (cardId && (!base || base.id !== cardId)) {
    state.error = "This card changed before editing began. Cancel and reopen it to continue.";
    params.requestUpdate?.();
    return;
  }
  const patch = base ? changedDraftPayload(state) : null;
  if (base && Object.keys(patch ?? {}).length === 0 && stagedAttachments.length === 0) {
    resetDraftState(state);
    params.requestUpdate?.();
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.draftSaving = true;
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    let attachmentBaselineCard = base;
    let fieldUpdateBase = base;
    if (cardId && stagedAttachments.length > 0) {
      try {
        attachmentBaselineCard = normalizeCardPayload(
          await params.client.request("workboard.cards.attachments.list", { id: cardId }),
        );
      } catch (error) {
        state.error = `Could not verify current attachments before upload: ${formatError(error)}`;
        return;
      }
      if (base && !hasOverlappingWorkboardDraftChange(base, attachmentBaselineCard, patch ?? {})) {
        fieldUpdateBase = attachmentBaselineCard;
      }
    }
    const existingAttachmentCount = attachmentBaselineCard?.metadata?.attachments?.length ?? 0;
    if (
      stagedAttachments.length > 0 &&
      existingAttachmentCount + stagedAttachments.length > WORKBOARD_MAX_CARD_ATTACHMENTS &&
      typeof window !== "undefined" &&
      !window.confirm(
        t("workboard.attachmentsPruneConfirm", {
          existing: String(existingAttachmentCount),
          staged: String(stagedAttachments.length),
          max: String(WORKBOARD_MAX_CARD_ATTACHMENTS),
        }),
      )
    ) {
      return;
    }
    let currentCard: WorkboardCard;
    if (base) {
      if (Object.keys(patch ?? {}).length > 0) {
        const payload = await params.client.request("workboard.cards.update", {
          id: cardId,
          expectedUpdatedAt: fieldUpdateBase?.updatedAt ?? base.updatedAt,
          patch,
        });
        currentCard = normalizeCardPayload(payload);
      } else {
        currentCard = attachmentBaselineCard ?? base;
      }
    } else {
      const payload = await params.client.request("workboard.cards.create", {
        ...draftPayload(state),
        ...selectedWorkboardBoardParams(state),
      });
      currentCard = normalizeCardPayload(payload);
    }
    replaceCard(state, currentCard);
    const uploadedAttachmentIds = new Set<string>();
    for (const staged of stagedAttachments) {
      let contentBase64: string;
      try {
        contentBase64 = await encodeWorkboardAttachment(staged.file);
      } catch (error) {
        state.draftAttachments = state.draftAttachments.filter(
          (entry) => !uploadedAttachmentIds.has(entry.id),
        );
        state.editingCardId = currentCard.id;
        state.editingCardBase = currentCard;
        state.draftOpen = true;
        state.error = `Attachment "${staged.fileName}" failed: ${formatError(error)} Uploaded files were saved; retry to continue.`;
        return;
      }
      try {
        const payload = await params.client.request("workboard.cards.attachments.add", {
          id: currentCard.id,
          fileName: staged.fileName,
          contentBase64,
          ...(staged.mimeType ? { mimeType: staged.mimeType } : {}),
        });
        currentCard = normalizeCardPayload(payload);
        uploadedAttachmentIds.add(staged.id);
        replaceCard(state, currentCard);
        if (state.editingCardId === currentCard.id) {
          state.editingCardBase = currentCard;
        }
      } catch (error) {
        state.draftAttachments = state.draftAttachments.filter(
          (entry) => !uploadedAttachmentIds.has(entry.id),
        );
        state.editingCardId = currentCard.id;
        state.editingCardBase = currentCard;
        state.draftOpen = true;
        const resultMessage = isAuthoritativeWorkboardAttachmentFailure(error)
          ? `failed: ${formatError(error)}`
          : "upload result is unconfirmed. Refresh the card before retrying";
        state.error = `Attachment "${staged.fileName}" ${resultMessage}; the file remains staged. Uploaded files were saved.`;
        return;
      }
    }
    resetDraftState(state);
  } catch (error) {
    if (
      base &&
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
