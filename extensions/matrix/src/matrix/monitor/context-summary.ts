// Matrix plugin module implements context summary behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  formatMatrixMessageText,
  resolveMatrixMessageAttachment,
  resolveMatrixMessageBody,
} from "../media-text.js";
import {
  formatPollAsText,
  isPollStartType,
  parsePollStartContent,
  type PollStartContent,
} from "../poll-types.js";
import type { MatrixRawEvent } from "./types.js";

export function summarizeMatrixMessageContextEvent(event: MatrixRawEvent): string | undefined {
  if (isPollStartType(event.type)) {
    const pollSummary = parsePollStartContent(event.content as PollStartContent);
    if (pollSummary) {
      return formatPollAsText(pollSummary);
    }
  }

  const content = event.content as { body?: unknown; filename?: unknown; msgtype?: unknown };
  return formatMatrixMessageText({
    body: resolveMatrixMessageBody({
      body: normalizeOptionalString(content.body),
      filename: normalizeOptionalString(content.filename),
      msgtype: normalizeOptionalString(content.msgtype),
    }),
    attachment: resolveMatrixMessageAttachment({
      body: normalizeOptionalString(content.body),
      filename: normalizeOptionalString(content.filename),
      msgtype: normalizeOptionalString(content.msgtype),
    }),
  });
}
