// Runtime-only type alias for reply dispatcher creation.
/** Type of the lazy reply dispatcher factory used by runtime dispatch paths. */
export type CreateReplyDispatcherWithTyping =
  typeof import("./reply-dispatcher.js").createReplyDispatcherWithTyping;
