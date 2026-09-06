// Leaf contract for the reply-suppression reason union. Kept import-free so
// downstream owners (cron completion status, command delivery) can reference the
// reason without pulling the heavy normalize-reply module into their type graph
// and forming an import cycle.
export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat" | "channel_transform";
