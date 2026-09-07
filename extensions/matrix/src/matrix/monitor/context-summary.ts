// Matrix plugin module implements context summary behavior.
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatMatrixMessageText, resolveMatrixReplacementContent } from "../media-text.js";
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

  const content = (resolveMatrixReplacementContent(event) ?? event.content) as {
    body?: unknown;
    filename?: unknown;
    msgtype?: unknown;
  };
  return formatMatrixMessageText({
    body: readStringValue(content.body),
    filename: readStringValue(content.filename),
    msgtype: normalizeOptionalString(content.msgtype),
  });
}
