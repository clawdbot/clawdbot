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
        "This bookmark is outside the current conversation or its original generation. You can still rename or remove it.",
    },
  },
} satisfies TranslationMap;

export const registerBookmarksEnglish = Object.assign(
  () => {
    Object.assign(en.chat.bookmarks, enBookmarks.chat.bookmarks);
  },
  { catalog: enBookmarks },
);
