// Matrix plugin module implements context summary behavior.
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatMatrixMessageText, resolveBundledMatrixReplacementContent } from "../media-text.js";
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

  // Thread roots do not reject redacted originals before projection; never
  // restore their content from a replacement bundled by the homeserver.
  const content = (
    event.unsigned?.redacted_because
      ? event.content
      : (resolveBundledMatrixReplacementContent(event) ?? event.content)
  ) as { body?: unknown; filename?: unknown; msgtype?: unknown };
  return formatMatrixMessageText({
    body: readStringValue(content.body),
    filename: readStringValue(content.filename),
    msgtype: normalizeOptionalString(content.msgtype),
  });
}
