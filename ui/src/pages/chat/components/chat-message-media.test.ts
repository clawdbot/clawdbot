import { beforeEach, describe, expect, it, vi } from "vitest";

const mediaPath = "media://inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf";
const readTranscriptMediaEntries = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/chat/message-extract.ts", () => ({
  readTranscriptMediaEntries,
}));
vi.mock("../../../lib/media-file-extension.ts", () => ({
  getMediaFileExtension: () => "pdf",
  hasVideoMediaFileExtension: () => false,
}));

import { extractTranscriptAttachments } from "./chat-message-media.ts";

describe("extractTranscriptAttachments", () => {
  beforeEach(() => {
    readTranscriptMediaEntries.mockReturnValue([{ path: mediaPath, mediaType: "application/pdf" }]);
  });

  it("restores the original label from a managed media-store path", () => {
    expect(
      extractTranscriptAttachments({
        role: "user",
        __openclaw: {
          media: [{ path: mediaPath, contentType: "application/pdf" }],
        },
      }),
    ).toEqual([
      {
        type: "attachment",
        attachment: {
          url: mediaPath,
          kind: "document",
          label: "report.pdf",
          mimeType: "application/pdf",
        },
      },
    ]);
  });

  it("prefers the authoritative filename without changing the managed URI", () => {
    readTranscriptMediaEntries.mockReturnValue([
      { path: mediaPath, mediaType: "application/pdf", fileName: "Quarterly report.pdf" },
    ]);

    expect(extractTranscriptAttachments({ role: "user" })).toEqual([
      {
        type: "attachment",
        attachment: {
          url: mediaPath,
          kind: "document",
          label: "Quarterly report.pdf",
          mimeType: "application/pdf",
        },
      },
    ]);
  });

  it("restores the original label for a canonical uppercase media URI", () => {
    const path = `MEDIA://inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf`;
    readTranscriptMediaEntries.mockReturnValue([{ path, mediaType: "application/pdf" }]);

    const [block] = extractTranscriptAttachments({ role: "user" });

    expect(block?.attachment).toMatchObject({ url: path, label: "report.pdf" });
  });

  it.each([
    `media://inbound/nested/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf`,
    `media://inbound/nested%2Freport---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf`,
    `/tmp/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf`,
  ])("does not rewrite a noncanonical inbound source: %s", (path) => {
    readTranscriptMediaEntries.mockReturnValue([{ path, mediaType: "application/pdf" }]);

    const [block] = extractTranscriptAttachments({ role: "user" });

    expect(block?.attachment.label).toContain("---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf");
  });
});
