import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  getChatAttachmentDataUrl,
  replaceChatAttachmentsFromEditor,
} from "./attachment-payload-store.ts";

const RESTORED_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

describe("replaceChatAttachmentsFromEditor", () => {
  it("restores size-cap inline images without a full-payload regex", () => {
    const data = "A".repeat(RESTORED_ATTACHMENT_MAX_BASE64_CHARS);

    const restored = replaceChatAttachmentsFromEditor([], [{ mimeType: "image/png", data }]);

    expect(restored).toHaveLength(1);
    const attachment = expectDefined(restored[0], "restored attachment");
    expect(attachment.mimeType).toBe("image/png");
    expect(getChatAttachmentDataUrl(attachment)).toBe(`data:image/png;base64,${data}`);
  });

  it("keeps malformed restored payloads fail-closed", () => {
    const rejected = ["", "not base64!!", "AAA", "AB=A", "A===", "====", "aW1h Z2U="];

    for (const data of rejected) {
      expect(replaceChatAttachmentsFromEditor([], [{ mimeType: "image/png", data }])).toEqual([]);
    }
    expect(
      replaceChatAttachmentsFromEditor(
        [],
        [
          { mimeType: "application/pdf", data: "aW1hZ2U=" },
          { mimeType: "image/png", data: "A".repeat(RESTORED_ATTACHMENT_MAX_BASE64_CHARS + 4) },
        ],
      ),
    ).toEqual([]);
  });
});
