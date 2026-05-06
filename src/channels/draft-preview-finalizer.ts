import {
  deliverFinalizableLivePreview,
  type LivePreviewFinalizerDraft,
  type LivePreviewFinalizerResultKind,
} from "./message/live.js";

/**
 * @deprecated Use `LivePreviewFinalizerDraft` from `openclaw/plugin-sdk/channel-message`.
 */
export type DraftPreviewFinalizerDraft<TId> = LivePreviewFinalizerDraft<TId>;

/**
 * @deprecated Use `LivePreviewFinalizerResult` from `openclaw/plugin-sdk/channel-message`.
 */
export type DraftPreviewFinalizerResult = Exclude<
  LivePreviewFinalizerResultKind,
  "preview-retained"
>;

/**
 * @deprecated Use `deliverFinalizableLivePreview` from `openclaw/plugin-sdk/channel-message`.
 */
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
  const result = await deliverFinalizableLivePreview({
    kind: params.kind,
    payload: params.payload,
    ...(params.draft ? { draft: params.draft } : {}),
    buildFinalEdit: params.buildFinalEdit,
    editFinal: params.editFinal,
    deliverNormally: params.deliverNormally,
    onPreviewFinalized: async (id) => {
      await params.onPreviewFinalized?.(id);
    },
    ...(params.onNormalDelivered ? { onNormalDelivered: params.onNormalDelivered } : {}),
    ...(params.logPreviewEditFailure
      ? { logPreviewEditFailure: params.logPreviewEditFailure }
      : {}),
  });

  return result.kind === "preview-retained" ? "normal-skipped" : result.kind;
}
