import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Bookmark controls load this copy with chat; the shared menu title stays eager.
const enBookmarks = {
  chat: {
    bookmarks: {
      personal: "Your saved message locations.",
      allConversations: "All conversations",
      storageUnavailable: "Personal preferences are unavailable. Reconnect and try again.",
      add: "Bookmark message",
      rename: "Rename bookmark",
      remove: "Remove bookmark",
      name: "Name",
      nameLimit: "{count}/70 characters",
      nearby: "{count} nearby bookmarks",
      collision:
        "{count} nearby bookmarks. Activate repeatedly to visit each; use Bookmarks in the session menu to choose by name.",
      search: "Search bookmarks",
      empty: "No bookmarks found.",
      reload: "Reload",
      unavailable:
        "This bookmark belongs to another conversation. You can still rename or remove it.",
      earlier: "Earlier conversation",
      readOnly: "Read-only",
      historyNotice:
        "This is a read-only excerpt from before the reset. Your current chat and draft are unchanged.",
      historyUnavailable: "The saved message is no longer available in this conversation.",
      back: "Back to bookmarks",
      showContext: "Show context",
      hideContext: "Hide context",
      markedMessage: "Bookmarked message",
      noPreview: "This message has no text or attachment preview.",
      user: "User",
      assistant: "Assistant",
      closePreview: "Close preview",
    },
  },
} satisfies TranslationMap;

export const registerBookmarksEnglish = Object.assign(
  () => {
    Object.assign(en.chat.bookmarks, enBookmarks.chat.bookmarks);
  },
  { catalog: enBookmarks },
);
