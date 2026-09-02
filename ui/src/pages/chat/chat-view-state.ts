import { resetChatComposerState } from "./components/chat-composer.ts";
import { resetThreadPresentation } from "./components/chat-thread-interactions.ts";

export function resetChatViewState(paneId?: string, owner?: ParentNode) {
  resetChatComposerState(paneId);
  resetThreadPresentation(paneId, owner);
}
