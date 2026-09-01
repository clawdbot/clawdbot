// Shared fixtures for LINE auto-reply delivery tests.
import type { messagingApi } from "@line/bot-sdk";
import { vi, type Mock } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { createLineSendReceipt } from "./send-receipt.js";

export type LineAutoReplyDeps = Parameters<typeof deliverLineAutoReply>[0]["deps"];

type LineAutoReplyTestDeps = {
  deps: LineAutoReplyDeps;
  replyMessageLine: Mock<LineAutoReplyDeps["replyMessageLine"]>;
  buildMediaMessage: (
    ...args: Parameters<LineAutoReplyDeps["buildMediaMessage"]>
  ) => Promise<messagingApi.Message>;
  pushMessagesLine: Mock<LineAutoReplyDeps["pushMessagesLine"]>;
};

export const LINE_TEST_CFG = { channels: { line: { accounts: { acc: {} } } } };

export const baseDeliveryParams = {
  cfg: LINE_TEST_CFG,
  to: "line:user:1",
  replyToken: "token",
  replyTokenUsed: false,
  accountId: "acc",
  textLimit: 5000,
};

export const createFlexMessage = (altText: string, contents: unknown) => ({
  type: "flex" as const,
  altText,
  contents,
});

/** LINE's wire shape for label-only quick replies, as the plugin builds them. */
export const createQuickReply = (...labels: string[]) => ({
  items: labels.map((label) => ({
    type: "action" as const,
    action: { type: "message" as const, label, text: label },
  })),
});

export const createImageMessage = (url: string) => ({
  type: "image" as const,
  originalContentUrl: url,
  previewImageUrl: url,
});

const createLocationMessage: LineAutoReplyDeps["createLocationMessage"] = (location) => ({
  type: "location" as const,
  ...location,
});

export function createDeps(overrides?: Partial<LineAutoReplyDeps>): LineAutoReplyTestDeps {
  const replyMessageLine = vi.fn<LineAutoReplyDeps["replyMessageLine"]>(async () => ({}));
  const buildMediaMessage: LineAutoReplyDeps["buildMediaMessage"] = vi.fn(
    async (mediaUrl, options) => {
      switch (options.mediaKind) {
        case "video":
          if (!options.previewImageUrl) {
            throw new Error(
              "LINE video messages require previewImageUrl to reference an image URL",
            );
          }
          return {
            type: "video" as const,
            originalContentUrl: mediaUrl,
            previewImageUrl: options.previewImageUrl,
          };
        case "audio":
          return {
            type: "audio" as const,
            originalContentUrl: mediaUrl,
            duration: options.durationMs ?? 60_000,
          };
        default:
          return createImageMessage(mediaUrl);
      }
    },
  );
  const pushMessagesLine = vi.fn<LineAutoReplyDeps["pushMessagesLine"]>(async () => ({
    messageId: "push",
    chatId: "u1",
    receipt: createLineSendReceipt({ messageId: "push", chatId: "u1", kind: "text" }),
  }));
  const deps: LineAutoReplyDeps = {
    buildTemplateMessageFromPayload: () => null,
    processLineMessage: (text) => ({ text, flexMessages: [] }),
    chunkMarkdownText: (text) => [text],
    replyMessageLine,
    pushMessagesLine,
    createFlexMessage: createFlexMessage as LineAutoReplyDeps["createFlexMessage"],
    buildMediaMessage,
    createLocationMessage,
    ...overrides,
  };

  return {
    deps,
    replyMessageLine,
    buildMediaMessage,
    pushMessagesLine,
  };
}
