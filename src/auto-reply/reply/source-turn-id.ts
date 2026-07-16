import { createHash } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAccountId } from "../../routing/account-id.js";

const CHANNEL_SOURCE_TURN_ID_PREFIX = "channel-user:v1:";
const CHANNEL_SOURCE_TURN_ID = Symbol("openclaw.channelSourceTurnId");
const CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED = Symbol(
  "openclaw.channelSourceTurnSameThreadRequired",
);

type ChannelSourceTurnContext = object & {
  [CHANNEL_SOURCE_TURN_ID]?: string;
  [CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED]?: true;
};

/**
 * Identifies one inbound channel turn across shared sessions.
 * Provider message ids are not globally unique, so route scope is mandatory.
 */
export function buildChannelSourceTurnId(params: {
  provider?: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string | number;
}): string | undefined {
  const provider = normalizeOptionalLowercaseString(params.provider);
  const conversationId = normalizeOptionalString(params.conversationId);
  const messageId = normalizeOptionalString(
    typeof params.messageId === "number" ? String(params.messageId) : params.messageId,
  );
  if (!provider || !conversationId || !messageId) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([provider, normalizeAccountId(params.accountId), conversationId, messageId]),
    )
    .digest("hex");
  return `${CHANNEL_SOURCE_TURN_ID_PREFIX}${digest}`;
}

/** Carries host-only source identity through internal context clones without public type drift. */
export function setChannelSourceTurnId(context: object, sourceTurnId: string | undefined): void {
  const scoped = context as ChannelSourceTurnContext;
  if (sourceTurnId) {
    scoped[CHANNEL_SOURCE_TURN_ID] = sourceTurnId;
  } else {
    delete scoped[CHANNEL_SOURCE_TURN_ID];
  }
}

export function readChannelSourceTurnId(context: object): string | undefined {
  return (context as ChannelSourceTurnContext)[CHANNEL_SOURCE_TURN_ID];
}

/** Carries the original channel adapter's narrowed message-action scope privately. */
export function setChannelSourceTurnSameThreadRequired(
  context: object,
  sameThreadRequired: boolean | undefined,
): void {
  const scoped = context as ChannelSourceTurnContext;
  if (sameThreadRequired === true) {
    scoped[CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED] = true;
  } else {
    delete scoped[CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED];
  }
}

export function readChannelSourceTurnSameThreadRequired(context: object): boolean {
  return (context as ChannelSourceTurnContext)[CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED] === true;
}
