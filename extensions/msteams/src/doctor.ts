// Msteams plugin module implements doctor behavior.
import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";

const isMSTeamsMutableAllowEntry = buildMutableAllowEntryDetector({
  prefixes: ["msteams:", "user:"],
  stableIdPattern: /^[^\s@]+$/,
});

export const collectMSTeamsMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "msteams",
    detector: isMSTeamsMutableAllowEntry,
    collectLists: (scope) => collectStandardAllowlistLists(scope),
  });
