// Irc plugin module implements doctor behavior.
import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";

const isIrcMutableAllowEntry = buildMutableAllowEntryDetector({
  stableIdPattern: /^(?:(?:irc|user):)*[^@]*@/i,
});

export const collectIrcMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "irc",
    detector: isIrcMutableAllowEntry,
    collectLists: (scope) =>
      collectStandardAllowlistLists(scope, { includeGroups: true, groupField: "allowFrom" }),
  });
