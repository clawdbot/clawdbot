// Tests reply history loading, trimming, and rendering for prompt context.
import { describe, expect, it } from "vitest";
import { normalizeHistoryMediaEntries, recordPendingHistoryEntryWithMedia } from "./history.js";
import type { HistoryEntry } from "./history.types.js";

describe("history media recording", () => {
  it("keeps only bounded local image and document media", () => {
    expect(
      normalizeHistoryMediaEntries({
        limit: 3,
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png" },
          { path: "https://example.com/b.png", contentType: "image/png" },
          { path: "/tmp/c.pdf", contentType: "application/pdf", kind: "document" },
          { path: "C:\\tmp\\d.jpg", kind: "image" },
          { path: "/tmp/e.jpg", kind: "image" },
        ],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
      {
        path: "/tmp/c.pdf",
        contentType: "application/pdf",
        kind: "document",
        messageId: "msg-1",
      },
      { path: "C:\\tmp\\d.jpg", kind: "image", messageId: "msg-1" },
    ]);
  });

  it("preserves native sticker classification for local sticker images", () => {
    expect(
      normalizeHistoryMediaEntries({
        messageId: "msg-sticker",
        media: [{ path: "/tmp/sticker.png", contentType: "image/png", kind: "sticker" }],
      }),
    ).toEqual([
      {
        path: "/tmp/sticker.png",
        contentType: "image/png",
        kind: "sticker",
        messageId: "msg-sticker",
      },
    ]);
  });

  it.each([
    {
      name: "an image with generic MIME and a .bin path",
      path: "/tmp/telegram-upload.bin",
      contentType: "application/octet-stream",
      kind: "image" as const,
    },
    {
      name: "a sticker with generic MIME and a .bin path",
      path: "/tmp/telegram-sticker.bin",
      contentType: "application/octet-stream",
      kind: "sticker" as const,
    },
    {
      name: "an extensionless sticker without transport MIME",
      path: "/tmp/telegram-sticker",
      contentType: undefined,
      kind: "sticker" as const,
    },
  ])("records $name at the actual channel history boundary", async (testCase) => {
    const historyMap = new Map<string, HistoryEntry[]>();

    await recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "telegram-chat",
      limit: 5,
      entry: {
        sender: "Alice",
        body: "<media:image>",
        messageId: "telegram-message",
      },
      media: async () => [
        {
          path: testCase.path,
          contentType: testCase.contentType,
          kind: testCase.kind,
        },
      ],
    });

    expect(historyMap.get("telegram-chat")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        messageId: "telegram-message",
        media: [
          {
            path: testCase.path,
            contentType: testCase.contentType,
            kind: testCase.kind,
            messageId: "telegram-message",
          },
        ],
      },
    ]);
  });

  it.each([
    { path: "/tmp/telegram-document.bin", contentType: "application/octet-stream" },
    { path: "/tmp/telegram-document.png", contentType: undefined },
    { path: "/tmp/telegram-document.png", contentType: "application/pdf" },
    { path: "/tmp/telegram-document.png", contentType: "image/png" },
  ])("records authoritative documents with MIME $contentType as documents", (media) => {
    expect(
      normalizeHistoryMediaEntries({
        media: [
          {
            ...media,
            kind: "document",
          },
        ],
      }),
    ).toEqual([
      {
        ...media,
        kind: "document",
        messageId: undefined,
      },
    ]);
  });

  it("enforces the aggregate history attachment byte budget", () => {
    expect(
      normalizeHistoryMediaEntries({
        maxBytes: 10,
        media: [
          { path: "/tmp/a.pdf", kind: "document", sizeBytes: 8 },
          { path: "/tmp/b.png", kind: "image", sizeBytes: 4 },
        ],
      }),
    ).toEqual([
      {
        path: "/tmp/a.pdf",
        kind: "document",
        sizeBytes: 8,
        messageId: undefined,
      },
    ]);
  });

  it.each(["application/pdf", "application/zip", "text/plain"] as const)(
    "never records unknown-kind image-looking documents with MIME %s",
    (contentType) => {
      expect(
        normalizeHistoryMediaEntries({
          media: [{ path: "/tmp/report.png", contentType, kind: "unknown" }],
        }),
      ).toEqual([]);
    },
  );

  it.each([
    { path: "/tmp/diagram.svg", kind: undefined },
    { path: "/tmp/diagram.svg", kind: "unknown" as const },
    { path: "/tmp/photo.png", kind: undefined },
    { path: "/tmp/photo.png", kind: "unknown" as const },
  ])("never manufactures image history from filename-only $path", (media) => {
    expect(normalizeHistoryMediaEntries({ media: [media] })).toEqual([]);
  });

  it.each([
    { path: "/tmp/diagram.svg", kind: "image" as const, contentType: undefined },
    { path: "/tmp/diagram.svg", kind: undefined, contentType: "image/svg+xml" },
  ])("preserves explicitly identified SVG history media", (media) => {
    expect(normalizeHistoryMediaEntries({ media: [media] })).toEqual([
      {
        ...media,
        kind: "image",
        messageId: undefined,
      },
    ]);
  });

  it("records filename-only SVG turns without manufacturing reusable image history", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();

    await recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "telegram-chat",
      limit: 5,
      entry: { sender: "Alice", body: "<media:document>", messageId: "diagram-message" },
      media: async () => [{ path: "/tmp/diagram.svg" }],
    });

    expect(historyMap.get("telegram-chat")).toEqual([
      { sender: "Alice", body: "<media:document>", messageId: "diagram-message" },
    ]);
  });

  it("records text history unchanged when media resolver has no usable media", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();

    await recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "channel-1",
      limit: 5,
      entry: { sender: "Alice", body: "hello", messageId: "msg-1" },
      media: async () => [{ path: "https://example.com/a.png", contentType: "image/png" }],
    });

    expect(historyMap.get("channel-1")).toEqual([
      { sender: "Alice", body: "hello", messageId: "msg-1" },
    ]);
  });

  it("records text history before async media resolution finishes", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    let resolveMedia!: (media: HistoryEntry["media"]) => void;
    const mediaPromise = new Promise<HistoryEntry["media"]>((resolve) => {
      resolveMedia = resolve;
    });

    const pending = recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "channel-1",
      limit: 5,
      entry: { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
      media: async () => await mediaPromise,
    });

    expect(historyMap.get("channel-1")).toEqual([
      { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
    ]);

    resolveMedia([{ path: "/tmp/a.png", contentType: "image/png" }]);
    await pending;

    expect(historyMap.get("channel-1")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
        ],
      },
    ]);
  });
});
