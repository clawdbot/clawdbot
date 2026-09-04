/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { createReplyPreviewResolver, type LoadedReplySource } from "./chat-reply-preview.ts";

describe("attachment reply previews", () => {
  it.each(["loaded", "fetched"] as const)(
    "describes a document-only source from %s history",
    (location) => {
      const sourceId = "document-source";
      const source = {
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              kind: "document",
              url: "https://files.example.test/report.pdf",
              label: "report.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
        __openclaw: { id: sourceId },
      };
      const resolve = createReplyPreviewResolver(
        new Map<string, LoadedReplySource>(
          location === "loaded"
            ? [[sourceId, { message: source, messageId: sourceId, senderLabel: "OpenClaw" }]]
            : [],
        ),
        {
          assistantName: "OpenClaw",
          userAvatar: null,
          userId: null,
          userName: null,
          replyMessageAccess: {
            revision: 0,
            navigationId: null,
            read: () => (location === "fetched" ? source : undefined),
            request: () => undefined,
            open: () => undefined,
          },
        },
      );

      expect(resolve(sourceId)).toMatchObject({
        sourceMessageId: sourceId,
        senderLabel: "OpenClaw",
        text: "report.pdf",
      });
    },
  );
});
