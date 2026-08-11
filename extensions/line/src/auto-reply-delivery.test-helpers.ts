// Shared fixtures for LINE auto-reply delivery tests.
import type { messagingApi } from "@line/bot-sdk";
import { vi, type Mock } from "vitest";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { createLineSendReceipt } from "./send-receipt.js";

export type LineAutoReplyDeps = Parameters<typeof deliverLineAutoReply>[0]["deps"];

type LineAutoReplyTestDeps = {
  deps: LineAutoReplyDeps;
  replyMessageLine: Mock<LineAutoReplyDeps["replyMessageLine"]>;
  createQuickReplyItems: Mock<(labels: string[]) => { items: string[] }>;
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

export const createImageMessage = (url: string) => ({
  type: "image" as const,
  originalContentUrl: url,
  previewImageUrl: url,
});

const createLocationMessage: LineAutoReplyDeps["createLocationMessage"] = (location) =>
  location.title.trim() && location.address.trim()
    ? {
        type: "location" as const,
        ...location,
      }
    : null;

export function createDeps(overrides?: Partial<LineAutoReplyDeps>): LineAutoReplyTestDeps {
  const replyMessageLine = vi.fn<LineAutoReplyDeps["replyMessageLine"]>(async () => ({}));
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
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
    createQuickReplyItems: createQuickReplyItems as LineAutoReplyDeps["createQuickReplyItems"],
    pushMessagesLine,
    createFlexMessage: createFlexMessage as LineAutoReplyDeps["createFlexMessage"],
    buildMediaMessage,
    createLocationMessage,
    ...overrides,
  };

  return {
    deps,
    replyMessageLine,
    createQuickReplyItems,
    buildMediaMessage,
    pushMessagesLine,
  };
}
