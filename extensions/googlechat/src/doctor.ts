// Googlechat plugin module implements doctor behavior.
import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";

const isGoogleChatMutableAllowEntry = buildMutableAllowEntryDetector({
  prefixes: ["googlechat:", "google-chat:", "gchat:", "users/"],
  stableIdPattern: /^[^@]+$/,
});

export const collectGoogleChatMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "googlechat",
    detector: isGoogleChatMutableAllowEntry,
    collectLists: (scope) =>
      collectStandardAllowlistLists(scope, {
        includeGroups: true,
        groupField: "users",
      }),
  });
