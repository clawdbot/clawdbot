export type DraftPreviewFinalizerDraft<TId> = {
  flush: () => Promise<void>;
  id: () => TId | undefined;
  seal?: () => Promise<void>;
  discardPending?: () => Promise<void>;
  clear: () => Promise<void>;
};

export type DraftPreviewFinalizerResult =
  | "normal-delivered"
  | "normal-skipped"
  | "preview-finalized";

export async function deliverFinalizableDraftPreview<TPayload, TId, TEdit>(params: {
  kind: "tool" | "block" | "final";
  payload: TPayload;
  draft?: DraftPreviewFinalizerDraft<TId>;
  buildFinalEdit: (payload: TPayload) => TEdit | undefined;
  editFinal: (id: TId, edit: TEdit) => Promise<void>;
  deliverNormally: (payload: TPayload) => Promise<boolean | void>;
  onPreviewFinalized?: (id: TId) => Promise<void> | void;
  onNormalDelivered?: () => Promise<void> | void;
  logPreviewEditFailure?: (error: unknown) => void;
}): Promise<DraftPreviewFinalizerResult> {
  if (params.kind !== "final" || !params.draft) {
    const delivered = await params.deliverNormally(params.payload);
    if (delivered === false) {
      return "normal-skipped";
    }
    await params.onNormalDelivered?.();
    return "normal-delivered";
  }

  const edit = params.buildFinalEdit(params.payload);
  if (edit !== undefined) {
    await params.draft.flush();
    const previewId = params.draft.id();
    if (previewId !== undefined) {
      await params.draft.seal?.();
      try {
        await params.editFinal(previewId, edit);
        await params.onPreviewFinalized?.(previewId);
        return "preview-finalized";
      } catch (err) {
        params.logPreviewEditFailure?.(err);
      }
    }
  }

  if (params.draft.discardPending) {
    await params.draft.discardPending();
  } else {
    await params.draft.clear();
  }

  let delivered = false;
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

  return delivered ? "normal-delivered" : "normal-skipped";
}
