import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  promoteRecentInboundHistoryMedia,
  resolveRecentInboundHistoryMedia,
} from "./history-media.js";

describe("recent inbound history media", () => {
  it("promotes bounded local images and documents into current media facts", () => {
    const now = 1_800_000_000_000;
    const ctx: MsgContext = {
      Timestamp: now,
      media: [{ path: "/media/current.png", contentType: "image/png", kind: "image" }],
      InboundHistory: [
        {
          sender: "member-a",
          body: "the worksheet",
          timestamp: now - 1_000,
          messageId: "m1",
          media: [
            {
              path: "/media/context.pdf",
              contentType: "application/pdf",
              kind: "document",
              sizeBytes: 512,
            },
            {
              path: "/media/context.png",
              contentType: "image/png",
              kind: "image",
              sizeBytes: 256,
            },
          ],
        },
      ],
    };

    expect(promoteRecentInboundHistoryMedia(ctx, { pathExists: () => true })).toHaveLength(2);
    expect(ctx.media).toEqual([
      { path: "/media/current.png", contentType: "image/png", kind: "image" },
      {
        path: "/media/context.pdf",
        contentType: "application/pdf",
        kind: "document",
        sizeBytes: 512,
        messageId: "m1",
      },
      {
        path: "/media/context.png",
        contentType: "image/png",
        kind: "image",
        sizeBytes: 256,
        messageId: "m1",
      },
    ]);
    expect(promoteRecentInboundHistoryMedia(ctx, { pathExists: () => true })).toEqual([]);
  });

  it("rejects remote, expired, unsupported, and over-budget history media", () => {
    const now = 1_800_000_000_000;
    const ctx: MsgContext = {
      Timestamp: now,
      InboundHistory: [
        {
          sender: "old",
          body: "old",
          timestamp: now - 25 * 60 * 60_000,
          media: [{ path: "/media/old.pdf", kind: "document", sizeBytes: 1 }],
        },
        {
          sender: "member",
          body: "files",
          timestamp: now,
          media: [
            { path: "https://example.test/a.pdf", kind: "document", sizeBytes: 1 },
            { path: "/media/a.mp3", kind: "audio", sizeBytes: 1 },
            { path: "/media/large.pdf", kind: "document", sizeBytes: 10 },
            { path: "/media/ok.pdf", kind: "document", sizeBytes: 2 },
          ],
        },
      ],
    };

    expect(
      resolveRecentInboundHistoryMedia({
        ctx,
        nowMs: now,
        maxBytes: 3,
        pathExists: () => true,
      }),
    ).toEqual([expect.objectContaining({ path: "/media/ok.pdf", kind: "document", sizeBytes: 2 })]);
  });

  it("skips local history media whose managed file has already expired", () => {
    const ctx: MsgContext = {
      Timestamp: 1_800_000_000_000,
      InboundHistory: [
        {
          sender: "member",
          body: "expired file",
          timestamp: 1_800_000_000_000,
          media: [{ path: "/media/missing.pdf", kind: "document", sizeBytes: 2 }],
        },
      ],
    };

    expect(resolveRecentInboundHistoryMedia({ ctx, pathExists: () => false })).toEqual([]);
    expect(promoteRecentInboundHistoryMedia(ctx, { pathExists: () => false })).toEqual([]);
    expect(ctx.media).toBeUndefined();
  });
});
