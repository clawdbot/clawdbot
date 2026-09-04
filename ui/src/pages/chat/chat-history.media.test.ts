import { describe, expect, it } from "vitest";
import {
  isEmptyUserTextOnlyMessage,
  readTranscriptMediaEntries,
} from "../../lib/chat/message-extract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { projectMessageMedia } from "./components/chat-message-media.ts";

const MANAGED_UUID = "43007e90-2ade-43f2-a781-42b843e9eca3";

function userMessageWithMedia(media: unknown[]): {
  role: string;
  content: string;
  __openclaw: { media: unknown[] };
} {
  return { role: "user", content: "", __openclaw: { media } };
}

describe("chat history canonical media filtering", () => {
  it.each([
    ["facts-only", [{ path: "/media/fact.png", contentType: "image/png" }]],
    ["sparse", [{}, { path: "/media/sparse.png", contentType: "image/png" }]],
    ["media-only", [{ url: "media://inbound/media-only.png", kind: "image" }]],
  ])("keeps an empty %s user row", (_name, media) => {
    expect(
      isEmptyUserTextOnlyMessage({
        role: "user",
        content: "",
        __openclaw: { media },
      }),
    ).toBe(false);
  });

  it.each([
    ["truly empty", { role: "user", content: "" }],
    ["metadata-only media", userMessageWithMedia([{ contentType: "image/png" }])],
  ])("drops a %s user row", (_name, message) => {
    expect(isEmptyUserTextOnlyMessage(message)).toBe(true);
  });

  it("renders a safe media-only user turn without rendering metadata-only local media", () => {
    const safeRef = "media://inbound/safe-history-image.png";
    const items = buildChatItems({
      paneId: "media-history",
      sessionKey: "main",
      messages: [
        userMessageWithMedia([{ path: safeRef, contentType: "image/png" }]),
        userMessageWithMedia([{ contentType: "image/png", fileName: "metadata-only-local.png" }]),
      ],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    const serialized = JSON.stringify(items);

    expect(serialized).toContain(safeRef);
    expect(serialized).not.toContain("metadata-only-local.png");
  });
});

describe("chat history attachment card labels", () => {
  it("carries the persisted canonical fileName through the media projection", () => {
    const entries = readTranscriptMediaEntries(
      userMessageWithMedia([
        {
          path: `media://inbound/report---${MANAGED_UUID}.pdf`,
          fileName: "report.pdf",
          contentType: "application/pdf",
        },
      ]),
    );
    expect(entries[0]?.fileName).toBe("report.pdf");
  });

  it("labels a managed inbound attachment with the persisted original fileName", () => {
    const { attachments } = projectMessageMedia(
      userMessageWithMedia([
        {
          path: `media://inbound/report---${MANAGED_UUID}.pdf`,
          fileName: "report.pdf",
          contentType: "application/pdf",
        },
      ]),
      [],
    );
    expect(attachments[0]?.attachment.label).toBe("report.pdf");
  });

  it("restores the original name from a legacy managed inbound UUID suffix when fileName is absent", () => {
    const { attachments } = projectMessageMedia(
      userMessageWithMedia([
        {
          path: `media://inbound/openclaw-attachment-test---${MANAGED_UUID}.docx`,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ]),
      [],
    );
    expect(attachments[0]?.attachment.label).toBe("openclaw-attachment-test.docx");
  });

  it("leaves non-managed https attachment paths unchanged", () => {
    // `---old` is not a canonical managed UUID suffix, so it must not be stripped
    // from https URLs (which never carry the collision-safe managed suffix).
    const { attachments } = projectMessageMedia(
      userMessageWithMedia([
        {
          path: "https://example.com/files/openclaw-attachment-test---old.docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ]),
      [],
    );
    expect(attachments[0]?.attachment.label).toBe("openclaw-attachment-test---old.docx");
  });

  it("does not strip a managed inbound basename that lacks a UUID suffix", () => {
    const { attachments } = projectMessageMedia(
      userMessageWithMedia([
        {
          path: "media://inbound/plain-name.docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ]),
      [],
    );
    expect(attachments[0]?.attachment.label).toBe("plain-name.docx");
  });

  it("strips only the terminal managed UUID suffix, preserving a UUID-shaped segment in the original name", () => {
    // Legacy record (no persisted fileName) whose original filename itself
    // contains a "---<uuid>"-shaped segment before the terminal managed suffix.
    const { attachments } = projectMessageMedia(
      userMessageWithMedia([
        {
          path: `media://inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890-final---${MANAGED_UUID}.docx`,
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      ]),
      [],
    );
    expect(attachments[0]?.attachment.label).toBe(
      "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890-final.docx",
    );
  });

  it("preserves a dotted UUID-shaped segment in a legacy attachment name", () => {
    const path = `media://inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.backup---${MANAGED_UUID}.pdf`;
    const { attachments } = projectMessageMedia(
      userMessageWithMedia([{ path, contentType: "application/pdf" }]),
      [],
    );

    expect(attachments[0]?.attachment).toMatchObject({
      url: path,
      label: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.backup.pdf",
      mimeType: "application/pdf",
    });
    expect(attachments[0]?.attachment.label).not.toContain(MANAGED_UUID);
  });
});
