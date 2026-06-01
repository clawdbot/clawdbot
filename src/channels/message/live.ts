import type { LiveMessageState, MessageReceipt, RenderedMessageBatch } from "./types.js";
export type { LiveMessagePhase, LiveMessageState } from "./types.js";

/** Mutable draft preview handle used before a live message is finalized or discarded. */
export type LivePreviewFinalizerDraft<TId> = {
  flush: () => Promise<void>;
  id: () => TId | undefined;
  seal?: () => Promise<void>;
  discardPending?: () => Promise<void>;
  clear: () => Promise<void>;
};

/** Outcome kind returned after attempting to finalize or fall back from a live preview. */
export type LivePreviewFinalizerResultKind =
  | "normal-delivered"
  | "normal-skipped"
  | "preview-finalized"
  | "preview-retained";

/** Result of a live preview finalization attempt plus the latest live state. */
export type LivePreviewFinalizerResult<TPayload> = {
  kind: LivePreviewFinalizerResultKind;
  liveState?: LiveMessageState<TPayload>;
};

/** Adapter contract for channels that can edit a draft preview into the final message. */
export type FinalizableLivePreviewAdapter<TPayload, TId, TEdit> = {
  draft?: LivePreviewFinalizerDraft<TId>;
  buildFinalEdit: (payload: TPayload) => TEdit | undefined;
  editFinal: (id: TId, edit: TEdit) => Promise<void>;
  resolveFinalizedId?: (id: TId, edit: TEdit) => TId | undefined;
  createPreviewReceipt?: (id: TId, edit: TEdit) => MessageReceipt;
  onPreviewFinalized?: (
    id: TId,
    receipt: MessageReceipt,
    liveState: LiveMessageState<TPayload>,
  ) => Promise<void> | void;
  buildSupplementalPayload?: (payload: TPayload) => TPayload | undefined;
  deliverSupplemental?: (payload: TPayload) => Promise<boolean | void>;
  handlePreviewEditError?: (params: {
    error: unknown;
    id: TId;
    edit: TEdit;
    payload: TPayload;
    liveState: LiveMessageState<TPayload>;
  }) => "fallback" | "retain" | Promise<"fallback" | "retain">;
  logPreviewEditFailure?: (error: unknown) => void;
};

/** Defines a finalizable live-preview adapter while preserving its generic payload/id/edit types. */
export function defineFinalizableLivePreviewAdapter<TPayload, TId, TEdit>(
  adapter: FinalizableLivePreviewAdapter<TPayload, TId, TEdit>,
): FinalizableLivePreviewAdapter<TPayload, TId, TEdit> {
  return adapter;
}

/** Creates the initial live-message state, optionally seeded with an existing preview receipt. */
export function createLiveMessageState<TPayload = unknown>(params?: {
  receipt?: MessageReceipt;
  lastRendered?: RenderedMessageBatch<TPayload>;
  canFinalizeInPlace?: boolean;
}): LiveMessageState<TPayload> {
  return {
    phase: params?.receipt ? "previewing" : "idle",
    canFinalizeInPlace: params?.canFinalizeInPlace ?? Boolean(params?.receipt),
    ...(params?.receipt ? { receipt: params.receipt } : {}),
    ...(params?.lastRendered ? { lastRendered: params.lastRendered } : {}),
  };
}

/** Marks a live message as finalized and disables further in-place preview edits. */
export function markLiveMessageFinalized<TPayload>(
  state: LiveMessageState<TPayload>,
  receipt: MessageReceipt,
): LiveMessageState<TPayload> {
  return {
    ...state,
    phase: "finalized",
    receipt,
    canFinalizeInPlace: false,
  };
}

/** Creates a receipt for a draft/preview platform message. */
export function createPreviewMessageReceipt(params: {
  id: unknown;
  threadId?: string;
  replyToId?: string;
  sentAt?: number;
  raw?: unknown;
}): MessageReceipt {
  const platformMessageId = String(params.id);
  return {
    primaryPlatformMessageId: platformMessageId,
    platformMessageIds: [platformMessageId],
    parts: [
      {
        platformMessageId,
        kind: "preview",
        index: 0,
        ...(params.threadId ? { threadId: params.threadId } : {}),
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      },
    ],
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    sentAt: params.sentAt ?? Date.now(),
    ...(params.raw === undefined ? {} : { raw: [{ meta: { raw: params.raw } }] }),
  };
}

/** Finalizes a live preview in place when possible, otherwise falls back to normal delivery. */
export async function deliverFinalizableLivePreview<TPayload, TId, TEdit>(params: {
  kind: "tool" | "block" | "final";
  payload: TPayload;
  liveState?: LiveMessageState<TPayload>;
  draft?: LivePreviewFinalizerDraft<TId>;
  buildFinalEdit: (payload: TPayload) => TEdit | undefined;
  editFinal: (id: TId, edit: TEdit) => Promise<void>;
  resolveFinalizedId?: (id: TId, edit: TEdit) => TId | undefined;
  deliverNormally: (payload: TPayload) => Promise<boolean | void>;
  createPreviewReceipt?: (id: TId, edit: TEdit) => MessageReceipt;
  onPreviewFinalized?: (
    id: TId,
    receipt: MessageReceipt,
    liveState: LiveMessageState<TPayload>,
  ) => Promise<void> | void;
  buildSupplementalPayload?: (payload: TPayload) => TPayload | undefined;
  deliverSupplemental?: (payload: TPayload) => Promise<boolean | void>;
  handlePreviewEditError?: (params: {
    error: unknown;
    id: TId;
    edit: TEdit;
    payload: TPayload;
    liveState: LiveMessageState<TPayload>;
  }) => "fallback" | "retain" | Promise<"fallback" | "retain">;
  onNormalDelivered?: () => Promise<void> | void;
  logPreviewEditFailure?: (error: unknown) => void;
}): Promise<LivePreviewFinalizerResult<TPayload>> {
  let liveState =
    params.liveState ??
    createLiveMessageState<TPayload>({ canFinalizeInPlace: Boolean(params.draft) });

  if (params.kind !== "final" || !params.draft) {
    const delivered = await params.deliverNormally(params.payload);
    if (delivered === false) {
      return { kind: "normal-skipped", liveState };
    }
    await params.onNormalDelivered?.();
    return { kind: "normal-delivered", liveState };
  }

  const edit = liveState.canFinalizeInPlace ? params.buildFinalEdit(params.payload) : undefined;
  if (edit !== undefined) {
    await params.draft.flush();
    const previewId = params.draft.id();
    if (previewId !== undefined) {
      await params.draft.seal?.();
      let editSucceeded = false;
      try {
        await params.editFinal(previewId, edit);
        editSucceeded = true;
      } catch (err) {
        params.logPreviewEditFailure?.(err);
        // Ambiguous preview edit failures can keep the preview as the visible final state.
        const decision =
          (await params.handlePreviewEditError?.({
            error: err,
            id: previewId,
            edit,
            payload: params.payload,
            liveState,
          })) ?? "fallback";
        if (decision === "retain") {
          const receipt =
            liveState.receipt ??
            params.createPreviewReceipt?.(previewId, edit) ??
            createPreviewMessageReceipt({ id: previewId });
          liveState = {
            ...liveState,
            phase: "previewing",
            canFinalizeInPlace: true,
            receipt,
          };
          return { kind: "preview-retained", liveState };
        }
      }
      if (editSucceeded) {
        const finalizedId = params.resolveFinalizedId?.(previewId, edit) ?? previewId;
        const receipt =
          params.createPreviewReceipt?.(finalizedId, edit) ??
          createPreviewMessageReceipt({ id: finalizedId });
        liveState = markLiveMessageFinalized(liveState, receipt);
        await params.onPreviewFinalized?.(finalizedId, receipt, liveState);
        const supplementalPayload = params.buildSupplementalPayload?.(params.payload);
        if (supplementalPayload !== undefined) {
          await params.deliverSupplemental?.(supplementalPayload);
        }
        return { kind: "preview-finalized", liveState };
      }
    }
  }

  if (params.draft.discardPending) {
    await params.draft.discardPending();
  } else {
    await params.draft.clear();
  }
  liveState = markLiveMessageCancelled(liveState);

  let delivered;
  try {
    const result = await params.deliverNormally(params.payload);
    delivered = result !== false;
    if (delivered) {
      await params.onNormalDelivered?.();
    }
  } finally {
    if (delivered) {
      await params.draft.clear();
    }
  }

  return { kind: delivered ? "normal-delivered" : "normal-skipped", liveState };
}

/** Runs live-preview finalization through an optional adapter, falling back to normal delivery. */
export async function deliverWithFinalizableLivePreviewAdapter<TPayload, TId, TEdit>(params: {
  kind: "tool" | "block" | "final";
  payload: TPayload;
  liveState?: LiveMessageState<TPayload>;
  adapter?: FinalizableLivePreviewAdapter<TPayload, TId, TEdit>;
  deliverNormally: (payload: TPayload) => Promise<boolean | void>;
  onNormalDelivered?: () => Promise<void> | void;
}): Promise<LivePreviewFinalizerResult<TPayload>> {
  if (!params.adapter) {
    const liveState = params.liveState ?? createLiveMessageState<TPayload>();
    const delivered = await params.deliverNormally(params.payload);
    if (delivered === false) {
      return { kind: "normal-skipped", liveState };
    }
    await params.onNormalDelivered?.();
    return { kind: "normal-delivered", liveState };
  }

  return await deliverFinalizableLivePreview({
    kind: params.kind,
    payload: params.payload,
    ...(params.liveState ? { liveState: params.liveState } : {}),
    draft: params.adapter.draft,
    buildFinalEdit: params.adapter.buildFinalEdit,
    editFinal: params.adapter.editFinal,
    ...(params.adapter.resolveFinalizedId
      ? { resolveFinalizedId: params.adapter.resolveFinalizedId }
      : {}),
    deliverNormally: params.deliverNormally,
    ...(params.adapter.createPreviewReceipt
      ? { createPreviewReceipt: params.adapter.createPreviewReceipt }
      : {}),
    ...(params.adapter.onPreviewFinalized
      ? { onPreviewFinalized: params.adapter.onPreviewFinalized }
      : {}),
    ...(params.adapter.buildSupplementalPayload
      ? { buildSupplementalPayload: params.adapter.buildSupplementalPayload }
      : {}),
    ...(params.adapter.deliverSupplemental
      ? { deliverSupplemental: params.adapter.deliverSupplemental }
      : {}),
    ...(params.adapter.handlePreviewEditError
      ? { handlePreviewEditError: params.adapter.handlePreviewEditError }
      : {}),
    ...(params.onNormalDelivered ? { onNormalDelivered: params.onNormalDelivered } : {}),
    ...(params.adapter.logPreviewEditFailure
      ? { logPreviewEditFailure: params.adapter.logPreviewEditFailure }
      : {}),
  });
}

/** Records the latest rendered preview batch and moves the live message into previewing state. */
export function markLiveMessagePreviewUpdated<TPayload>(
  state: LiveMessageState<TPayload>,
  rendered: RenderedMessageBatch<TPayload>,
): LiveMessageState<TPayload> {
  return {
    ...state,
    phase: "previewing",
    lastRendered: rendered,
  };
}

/** Marks a live message cancelled and prevents later in-place finalization. */
export function markLiveMessageCancelled<TPayload>(
  state: LiveMessageState<TPayload>,
): LiveMessageState<TPayload> {
  return {
    ...state,
    phase: "cancelled",
    canFinalizeInPlace: false,
  };
}
