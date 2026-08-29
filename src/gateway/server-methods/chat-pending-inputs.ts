import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatPendingInputsPage } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  listSessionPendingInputs,
  type SessionPendingInput,
} from "../../config/sessions/session-accessor.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { replaceOversizedChatHistoryMessages } from "./chat-history-budget.js";

const PENDING_INPUT_DISPLAY_MAX_BYTES = 128 * 1024;
// Correlation is useful for browser UUIDs, but arbitrary external run IDs must
// not turn a bounded display page into an unbounded payload. Never truncate IDs.
const PENDING_INPUT_CORRELATION_MAX_CHARS = 256;

export function projectPendingInputMessage(input: SessionPendingInput, maxChars: number) {
  const message = projectChatDisplayMessage(input.message, {
    maxChars,
    resolveCurrentUserProfileDisplay,
  });
  if (!message) {
    return undefined;
  }
  const metadata = { ...asOptionalRecord(message?.__openclaw) };
  delete metadata.idempotencyKey;
  delete metadata.runId;
  return {
    ...message,
    idempotencyKey: undefined,
    __openclaw: { ...metadata, id: `${CHAT_PENDING_INPUT_MESSAGE_PREFIX}${input.id}` },
  };
}

export function readChatPendingInputs(
  scope: Parameters<typeof listSessionPendingInputs>[0],
  options: { before?: number; limit: number; maxChars: number },
): ChatPendingInputsPage {
  const page = listSessionPendingInputs(scope, {
    before: options.before,
    limit: Math.min(options.limit, 20),
  });
  const visible = page.items.flatMap((input) => {
    const message = projectPendingInputMessage(input, options.maxChars);
    return message ? [{ input, message }] : [];
  });
  const messages = replaceOversizedChatHistoryMessages({
    messages: visible.map(({ message }) => message),
    maxSingleMessageBytes: Math.floor(
      PENDING_INPUT_DISPLAY_MAX_BYTES / Math.max(page.items.length, 1),
    ),
  }).messages;
  return {
    ...page,
    items: visible.map(({ input: item }, index) => ({
      id: item.id,
      ...(item.runId.length <= PENDING_INPUT_CORRELATION_MAX_CHARS ? { runId: item.runId } : {}),
      acceptedAt: item.acceptedAt,
      state: item.state,
      message: messages[index],
    })),
  };
}
