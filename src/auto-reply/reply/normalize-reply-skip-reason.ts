// Import-free normalization contracts keep downstream owners out of the
// runtime normalizer's type graph. Callers supply their own payload shape.
export type NormalizeReplySkipReason = "empty" | "silent" | "heartbeat" | "channel_transform";

export type NormalizeReplyOutcome<T> =
  | { kind: "deliver"; payload: T }
  | { kind: "suppress"; reason: NormalizeReplySkipReason };
