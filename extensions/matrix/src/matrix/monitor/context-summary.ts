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

export function trimMatrixMaybeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

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
      body: trimMatrixMaybeString(content.body),
      filename: trimMatrixMaybeString(content.filename),
      msgtype: trimMatrixMaybeString(content.msgtype),
    }),
    attachment: resolveMatrixMessageAttachment({
      body: trimMatrixMaybeString(content.body),
      filename: trimMatrixMaybeString(content.filename),
      msgtype: trimMatrixMaybeString(content.msgtype),
    }),
  });
}
