import { setTimeout as sleep } from "node:timers/promises";
import {
  createFailureAwareTransportWaitForCondition,
  findFailureOutboundMessage as findTransportFailureOutboundMessage,
  waitForQaTransportCondition,
  type QaTransportState,
} from "./qa-transport.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type { QaBusMessage } from "./runtime-api.js";

function findFailureOutboundMessage(
  state: QaTransportState,
  options?: { sinceIndex?: number; cursorSpace?: "all" | "outbound" },
) {
  return findTransportFailureOutboundMessage(state, options);
}

function createScenarioWaitForCondition(state: QaTransportState) {
  return createFailureAwareTransportWaitForCondition(state);
}

const waitForCondition = createScenarioWaitForCondition;

async function waitForOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs = 15_000,
  options?: { sinceIndex?: number },
) {
  return await waitForQaTransportCondition(() => {
    const failureMessage = findFailureOutboundMessage(state, options);
    if (failureMessage) {
      throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
    }
    const match = state
      .getSnapshot()
      .messages.filter((message: QaBusMessage) => message.direction === "outbound")
      .slice(options?.sinceIndex ?? 0)
      .find(predicate);
    if (!match) {
      return undefined;
    }
    const failureReply = extractQaFailureReplyText(match.text);
    if (failureReply) {
      throw new Error(failureReply);
    }
    return match;
  }, timeoutMs);
}

async function waitForNoOutbound(state: QaTransportState, timeoutMs = 1_200) {
  await sleep(timeoutMs);
  const outbound = state
    .getSnapshot()
    .messages.filter((message: QaBusMessage) => message.direction === "outbound");
  if (outbound.length > 0) {
    throw new Error(`expected no outbound messages, saw ${outbound.length}`);
  }
}

function recentOutboundSummary(state: QaTransportState, limit = 5) {
  return state
    .getSnapshot()
    .messages.filter((message: QaBusMessage) => message.direction === "outbound")
    .slice(-limit)
    .map((message: QaBusMessage) => `${message.conversation.id}:${message.text}`)
    .join(" | ");
}

function readTransportTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
  },
) {
  const messages = state
    .getSnapshot()
    .messages.filter(
      (message: QaBusMessage) =>
        message.conversation.id === params.conversationId &&
        (params.threadId ? message.threadId === params.threadId : true) &&
        (params.direction ? message.direction === params.direction : true),
    );
  return params.limit ? messages.slice(-params.limit) : messages;
}

function formatTransportTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
  },
) {
  const messages = readTransportTranscript(state, params);
  return messages
    .map((message: QaBusMessage) => {
      const direction = message.direction === "inbound" ? "user" : "assistant";
      const speaker = message.senderName?.trim() || message.senderId;
      const attachmentSummary =
        message.attachments && message.attachments.length > 0
          ? ` [attachments: ${message.attachments
              .map(
                (attachment: NonNullable<QaBusMessage["attachments"]>[number]) =>
                  `${attachment.kind}:${attachment.fileName ?? attachment.id}`,
              )
              .join(", ")}]`
          : "";
      return `${direction.toUpperCase()} ${speaker}: ${message.text}${attachmentSummary}`;
    })
    .join("\n\n");
}

function formatConversationTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    limit?: number;
  },
) {
  return formatTransportTranscript(state, params);
}

async function waitForTransportOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs?: number,
) {
  return await waitForOutboundMessage(state, predicate, timeoutMs);
}

async function waitForChannelOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs?: number,
) {
  return await waitForTransportOutboundMessage(state, predicate, timeoutMs);
}

async function waitForNoTransportOutbound(state: QaTransportState, timeoutMs = 1_200) {
  await waitForNoOutbound(state, timeoutMs);
}

export {
  createScenarioWaitForCondition,
  findFailureOutboundMessage,
  formatConversationTranscript,
  formatTransportTranscript,
  readTransportTranscript,
  recentOutboundSummary,
  waitForChannelOutboundMessage,
  waitForCondition,
  waitForNoOutbound,
  waitForNoTransportOutbound,
  waitForOutboundMessage,
  waitForTransportOutboundMessage,
};
