export function resolveStreamingCardSendMode(options?: {
  replyToMessageId?: string;
  rootId?: string;
}): "reply" | "root_create" | "create" {
  if (options?.replyToMessageId) {
    return "reply";
  }
  if (options?.rootId) {
    return "root_create";
  }
  return "create";
}
