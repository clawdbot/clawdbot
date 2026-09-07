// Qa Lab plugin module implements self check scenario behavior.
import { extractQaToolPayload } from "./extract-tool-payload.js";
import type { QaTransportState } from "./qa-transport.js";
import type { QaBusMessage } from "./runtime-api.js";
import type { QaScenarioDefinition } from "./scenario.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";

export function createQaSelfCheckScenario(options?: {
  waitTimeoutMs?: number;
}): QaScenarioDefinition {
  const waitTimeoutMs = options?.waitTimeoutMs ?? 5_000;
  let lifecycle: { target: string; message: QaBusMessage } | undefined;
  const waitForReply = (state: QaTransportState, inbound: QaBusMessage) =>
    waitForOutboundMessage(
      state,
      (message) =>
        message.conversation.id === inbound.conversation.id &&
        message.conversation.kind === inbound.conversation.kind &&
        message.threadId === inbound.threadId &&
        message.text.includes(`qa-echo: ${inbound.text}`),
      waitTimeoutMs,
      { accountId: inbound.accountId },
    );
  return {
    name: "Synthetic Slack-class roundtrip",
    steps: [
      {
        name: "DM echo roundtrip",
        async run({ state }) {
          const inbound = await state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "hello from qa",
          });
          await waitForReply(state, inbound);
        },
      },
      {
        name: "Thread create and threaded echo",
        async run({ state, performAction }) {
          if (!performAction) {
            throw new Error("self-check action dispatcher is not configured");
          }
          const threadResult = await performAction("thread-create", {
            channelId: "qa-room",
            title: "QA thread",
          });
          const threadPayload = extractQaToolPayload(
            threadResult as Parameters<typeof extractQaToolPayload>[0],
          ) as { target?: string; thread?: { id?: string } } | undefined;
          const threadId = threadPayload?.thread?.id;
          if (!threadId || !threadPayload?.target) {
            throw new Error("thread-create did not return thread id and target");
          }

          const inbound = await state.addInboundMessage({
            conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
            senderId: "alice",
            senderName: "Alice",
            text: "inside thread",
            threadId,
            threadTitle: "QA thread",
          });
          lifecycle = {
            target: threadPayload.target,
            message: await waitForReply(state, inbound),
          };
          return threadId;
        },
      },
      {
        name: "Reaction, edit, delete lifecycle",
        async run({ state, performAction }) {
          if (!performAction) {
            throw new Error("self-check action dispatcher is not configured");
          }
          if (!lifecycle) {
            throw new Error("threaded outbound message and target not found");
          }
          const { target, message: outboundMessage } = lifecycle;

          await performAction("react", {
            to: target,
            messageId: outboundMessage.id,
            emoji: "white_check_mark",
          });
          const reacted = await state.readMessage({ messageId: outboundMessage.id });
          if (!reacted) {
            throw new Error("reacted message not found");
          }
          if (reacted.reactions.length === 0) {
            throw new Error("reaction not recorded");
          }

          await performAction("edit", {
            to: target,
            messageId: outboundMessage.id,
            text: "qa-echo: inside thread (edited)",
          });
          const edited = await state.readMessage({ messageId: outboundMessage.id });
          if (!edited) {
            throw new Error("edited message not found");
          }
          if (!edited.text.includes("(edited)")) {
            throw new Error("edit not recorded");
          }

          await performAction("delete", {
            to: target,
            messageId: outboundMessage.id,
          });
          const deleted = await state.readMessage({ messageId: outboundMessage.id });
          if (!deleted) {
            throw new Error("deleted message not found");
          }
          if (!deleted.deleted) {
            throw new Error("delete not recorded");
          }
        },
      },
    ],
  };
}
