import { extractQaToolPayload } from "./extract-tool-payload.js";
import type { QaScenarioDefinition } from "./scenario.js";

export function createQaSelfCheckScenario(): QaScenarioDefinition {
  return {
    name: "Synthetic Slack-class roundtrip",
    steps: [
      {
        name: "DM echo roundtrip",
        async run({ state }) {
          await state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "hello from qa",
          });
          await state.waitFor({
            kind: "message-text",
            textIncludes: "qa-echo: hello from qa",
            direction: "outbound",
            timeoutMs: 5_000,
          });
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
          ) as { thread?: { id?: string } } | undefined;
          const threadId = threadPayload?.thread?.id;
          if (!threadId) {
            throw new Error("thread-create did not return thread id");
          }

          await state.addInboundMessage({
            conversation: { id: "qa-room", kind: "channel", title: "QA Room" },
            senderId: "alice",
            senderName: "Alice",
            text: "inside thread",
            threadId,
            threadTitle: "QA thread",
          });
          await state.waitFor({
            kind: "message-text",
            textIncludes: "qa-echo: inside thread",
            direction: "outbound",
            timeoutMs: 5_000,
          });
          return threadId;
        },
      },
      {
        name: "Reaction, edit, delete lifecycle",
        async run({ state, performAction }) {
          if (!performAction) {
            throw new Error("self-check action dispatcher is not configured");
          }
          const outboundMessage = (
            await state.searchMessages({
              query: "qa-echo: inside thread",
              conversationId: "qa-room",
            })
          ).at(-1);
          if (!outboundMessage) {
            throw new Error("threaded outbound message not found");
          }

          await performAction("react", {
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
