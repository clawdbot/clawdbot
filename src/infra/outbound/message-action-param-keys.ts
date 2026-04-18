import { normalizeOptionalString } from "../../shared/string-coerce.js";

const STANDARD_MESSAGE_ACTION_PARAM_KEYS = new Set([
  "accountId",
  "asDocument",
  "base64",
  "bestEffort",
  "blocks",
  "buttons",
  "caption",
  "card",
  "channel",
  "channelId",
  "components",
  "contentType",
  "dryRun",
  "filePath",
  "fileUrl",
  "filename",
  "forceDocument",
  "gifPlayback",
  "image",
  "interactive",
  "media",
  "mediaUrl",
  "message",
  "mimeType",
  "path",
  "pollAnonymous",
  "pollDurationHours",
  "pollMulti",
  "pollOption",
  "pollPublic",
  "pollQuestion",
  "replyTo",
  "silent",
  "target",
  "targets",
  "text",
  "threadId",
  "to",
]);

export function hasPotentialPluginActionParam(params: Record<string, unknown>): boolean {
  return Object.entries(params).some(([key, value]) => {
    if (STANDARD_MESSAGE_ACTION_PARAM_KEYS.has(key)) {
      return false;
    }
    if (typeof value === "string") {
      return Boolean(normalizeOptionalString(value));
    }
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return value !== undefined;
  });
}
