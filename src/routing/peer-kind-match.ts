// Peer kind matching helpers compare channel peer kinds against chat targets.
import type { ChatType } from "../channels/chat-type.js";

// Routing treats group and channel peers as compatible because several chat
// platforms expose broadcast-like group spaces with either label.
export function peerKindMatches(bindingKind: ChatType, scopeKind: ChatType): boolean {
  if (bindingKind === scopeKind) {
    return true;
  }
  return (
    (bindingKind === "group" && scopeKind === "channel") ||
    (bindingKind === "channel" && scopeKind === "group")
  );
}
