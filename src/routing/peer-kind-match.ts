import type { ChatType } from "../channels/chat-type.js";

export function peerKindMatches(bindingKind: ChatType, scopeKind: ChatType): boolean {
  if (bindingKind === scopeKind) {
    return true;
  }
  return (
    (bindingKind === "group" && scopeKind === "channel") ||
    (bindingKind === "channel" && scopeKind === "group")
  );
}
