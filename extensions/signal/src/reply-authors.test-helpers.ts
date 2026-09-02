// Signal test support resets native-reply quote author state.
import { signalReplyAuthorState } from "./reply-authors-state.js";

export function resetSignalReplyAuthorsForTests(): void {
  signalReplyAuthorState.memoryReplyContexts.clear();
  signalReplyAuthorState.persistentStoreDisabled = false;
}
