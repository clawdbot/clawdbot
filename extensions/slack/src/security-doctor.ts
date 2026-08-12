// Slack plugin module implements security doctor behavior.
import { buildMutableAllowEntryDetector } from "openclaw/plugin-sdk/channel-policy";

export const isSlackMutableAllowEntry = buildMutableAllowEntryDetector({
  stableIdPattern:
    /^(?:team:T[A-Z0-9]+:user:[UW][A-Z0-9]+|(?:(?:(?:slack|user):)?(?:[UWBCGDT][A-Z0-9]{2,}|[A-Z0-9]{8,})|<@[A-Z0-9]{8,}>))$/i,
});
