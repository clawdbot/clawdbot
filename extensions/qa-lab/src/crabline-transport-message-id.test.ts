import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

const PROVIDER_CASES = [
  {
    channel: "telegram",
    conversation: { id: "-1001234567890", kind: "group" },
    senderId: "100001",
    nativeMessageId: /^\d+$/u,
  },
  {
    channel: "slack",
    conversation: { id: "D12345678", kind: "direct" },
    senderId: "U12345678",
    nativeMessageId: /^\d+\.\d+$/u,
  },
  {
    channel: "matrix",
    conversation: { id: "main", kind: "group" },
    senderId: "driver",
    nativeMessageId: /^\$[a-f0-9]{16}:matrix\.test$/u,
  },
] as const;

describe("Crabline provider-native inbound message identity", () => {
  it.each(PROVIDER_CASES)(
    "keeps $channel message IDs consistent across the returned message and bus state",
    async ({ channel, conversation, senderId, nativeMessageId }) => {
      await withTempDir("qa-crabline-message-id-", async (outputDir) => {
        const busState = createQaBusState();
        const transport = await createQaCrablineTransportAdapter({
          outputDir,
          selection: {
            capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
            channel,
            channelDriver: "crabline",
            smokeArtifactPath: "crabline-fake-provider-smoke.json",
          },
          state: busState,
        });

        try {
          const inbound = await transport.sendInbound({
            conversation,
            senderId,
            senderName: "Alice",
            text: `${channel} provider-native identity`,
          });
          const snapshot = transport.state.getSnapshot();

          expect(inbound.id).toMatch(nativeMessageId);
          expect(snapshot.messages).toContainEqual(
            expect.objectContaining({ direction: "inbound", id: inbound.id }),
          );
          expect(snapshot.events).toContainEqual(
            expect.objectContaining({
              kind: "inbound-message",
              message: expect.objectContaining({ id: inbound.id }),
            }),
          );
          expect(busState.poll().events).toContainEqual(
            expect.objectContaining({
              kind: "inbound-message",
              message: expect.objectContaining({ id: inbound.id }),
            }),
          );
          expect(transport.state.readMessage({ messageId: inbound.id })).toMatchObject({
            direction: "inbound",
            id: inbound.id,
          });
        } finally {
          await transport.cleanup?.();
        }
      });
    },
  );

  it("preserves Telegram message IDs repeated across independent chats", async () => {
    await withTempDir("qa-crabline-colliding-message-ids-", async (outputDir) => {
      const busState = createQaBusState();
      const createTelegramTransport = async (name: string) =>
        await createQaCrablineTransportAdapter({
          outputDir: `${outputDir}/${name}`,
          selection: {
            capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
            channel: "telegram",
            channelDriver: "crabline",
            smokeArtifactPath: "crabline-fake-provider-smoke.json",
          },
          state: busState,
        });
      const firstTransport = await createTelegramTransport("first");

      try {
        const secondTransport = await createTelegramTransport("second");

        try {
          const first = await firstTransport.sendInbound({
            conversation: { id: "-1001234567890", kind: "group" },
            senderId: "100001",
            text: "first Telegram chat",
          });
          const second = await secondTransport.sendInbound({
            conversation: { id: "-1001234567891", kind: "group" },
            senderId: "100001",
            text: "second Telegram chat",
          });
          const snapshot = busState.getSnapshot();

          expect(first.id).toBe(second.id);
          expect(snapshot.messages.map((message) => message.conversation.id)).toEqual([
            first.conversation.id,
            second.conversation.id,
          ]);
          expect(snapshot.events).toEqual([
            expect.objectContaining({
              message: expect.objectContaining({
                id: first.id,
                conversation: expect.objectContaining({ id: first.conversation.id }),
              }),
            }),
            expect.objectContaining({
              message: expect.objectContaining({
                id: second.id,
                conversation: expect.objectContaining({ id: second.conversation.id }),
              }),
            }),
          ]);
          expect(() => busState.readMessage({ messageId: first.id })).toThrow(
            `qa-bus message id is ambiguous for selected account: ${first.id}`,
          );
        } finally {
          await secondTransport.cleanup?.();
        }
      } finally {
        await firstTransport.cleanup?.();
      }
    });
  });
});
