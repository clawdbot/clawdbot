// Slack plugin module implements security doctor behavior.
import { buildMutableAllowEntryDetector } from "openclaw/plugin-sdk/channel-policy";
import { parseSlackTarget } from "./target-parsing.js";

const isSlackMutableUnqualifiedAllowEntry = buildMutableAllowEntryDetector({
  stableIdPattern:
    /^(?:(?:(?:[sS][lL][aA][cC][kK]|[uU][sS][eE][rR]):)?(?:[UWBCGDT][A-Z0-9]{2,}|[A-Za-z0-9]{8,})|<@[A-Za-z0-9]{8,}>)$/,
});

export function isSlackMutableAllowEntry(entry: string): boolean {
  if (/^team:/i.test(entry)) {
    try {
      const target = parseSlackTarget(entry);
      if (target?.kind === "user" && target.teamId) {
        return false;
      }
    } catch {
      // Invalid qualified entries remain mutable so Doctor reports them.
    }
  }
  return isSlackMutableUnqualifiedAllowEntry(entry);
}
