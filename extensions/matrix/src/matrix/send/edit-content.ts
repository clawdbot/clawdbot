import { asNullableObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixReplacement, resolveMatrixReplacementContent } from "../media-text.js";
import type { MatrixClient, MatrixRawEvent } from "../sdk.js";
import { getMatrixEventProjection } from "../sdk/event-helpers.js";

const MAX_EDIT_RELATION_PAGES = 100;
const EDIT_RELATION_PAGE_SIZE = 100;
const EDIT_DECRYPTION_ERROR =
  "Matrix edit history is not fully decrypted; restore encryption keys before editing.";

export async function resolveMatrixEditContent(params: {
  client: MatrixClient;
  roomId: string;
  event: MatrixRawEvent | null;
}): Promise<Record<string, unknown> | undefined> {
  const { client, roomId, event } = params;
  if (!event || event.unsigned?.redacted_because || event.state_key !== undefined) {
    return event?.content;
  }
  const projection = getMatrixEventProjection(event);
  if (projection?.decryptionFailure || event.type === "m.room.encrypted") {
    throw new Error(EDIT_DECRYPTION_ERROR);
  }
  const originalContent = projection?.originalContent ?? event.content;
  const embedded =
    resolveMatrixReplacementContent(event) ??
    asNullableObjectRecord(originalContent?.["m.new_content"]);
  if (embedded) {
    return embedded;
  }

  // Query every wire type even without cached room encryption state. Pages are
  // topological; Matrix chooses the latest edit by timestamp, then event ID.
  let latest: MatrixRawEvent | undefined;
  let latestReplacement: ReturnType<typeof resolveMatrixReplacement>;
  let from: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageIndex = 0; pageIndex < MAX_EDIT_RELATION_PAGES; pageIndex++) {
    const page = await client.getRelations(roomId, event.event_id, "m.replace", undefined, {
      from,
      limit: EDIT_RELATION_PAGE_SIZE,
    });
    for (const replacement of page.events) {
      const replacementContent = resolveMatrixReplacement(event, replacement);
      if (
        replacementContent &&
        (!latest ||
          replacement.origin_server_ts > latest.origin_server_ts ||
          (replacement.origin_server_ts === latest.origin_server_ts &&
            replacement.event_id > latest.event_id))
      ) {
        latest = replacement;
        latestReplacement = replacementContent;
      }
    }
    from = page.nextBatch ?? undefined;
    if (!from) {
      if (latestReplacement?.kind === "unreadable") {
        throw new Error(EDIT_DECRYPTION_ERROR);
      }
      return latestReplacement?.content ?? originalContent;
    }
    if (seenCursors.has(from)) {
      break;
    }
    seenCursors.add(from);
  }
  // Never send a notification delta computed from an incomplete edit history.
  throw new Error("Matrix edit history could not be fully read; send a new message instead.");
}
