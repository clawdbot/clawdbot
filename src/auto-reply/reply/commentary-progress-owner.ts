import type { GetReplyOptions } from "../get-reply-options.types.js";

type CommentaryProgressOwnerOptions = Pick<
  GetReplyOptions,
  "onVerboseProgressVisibility" | "shouldDeliverCommentaryPayloads"
>;

/** Freezes and registers one commentary owner for the current agent turn. */
export function resolveTurnCommentaryProgressOwner(params: {
  commentaryPayloadsEnabled: boolean;
  options?: CommentaryProgressOwnerOptions;
  resolveVerboseProgressVisibility: () => boolean;
}): {
  commentaryPayloadsEnabled: boolean;
  draftOwnsCommentaryProgress: boolean;
} {
  const shouldDeliverCommentaryPayloads = params.commentaryPayloadsEnabled
    ? params.options?.shouldDeliverCommentaryPayloads
    : undefined;
  const frozenVerboseProgressVisibility = shouldDeliverCommentaryPayloads
    ? params.resolveVerboseProgressVisibility()
    : undefined;
  params.options?.onVerboseProgressVisibility?.(
    frozenVerboseProgressVisibility === undefined
      ? params.resolveVerboseProgressVisibility
      : () => frozenVerboseProgressVisibility,
  );
  const commentaryPayloadsEnabled =
    params.commentaryPayloadsEnabled && (shouldDeliverCommentaryPayloads?.() ?? true);
  return {
    commentaryPayloadsEnabled,
    draftOwnsCommentaryProgress:
      params.commentaryPayloadsEnabled &&
      shouldDeliverCommentaryPayloads !== undefined &&
      !commentaryPayloadsEnabled,
  };
}
