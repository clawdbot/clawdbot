import { describe, expect, it } from "vitest";

import { extractAttachmentsFromPrompt, extractTextFromPrompt } from "./event-mapper.js";

describe("acp event mapper", () => {
  it("extracts text and resource blocks into prompt text", () => {
    const text = extractTextFromPrompt([
      { type: "text", text: "Hello" },
      { type: "resource", resource: { text: "File contents" } },
      { type: "resource_link", uri: "https://example.com", title: "Spec" },
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);

    expect(text).toBe(
      "Hello\nFile contents\n[Resource link (Spec)] https://example.com",
    );
  });

  it("extracts image blocks into gateway attachments", () => {
    const attachments = extractAttachmentsFromPrompt([
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "text", text: "ignored" },
    ]);

    expect(attachments).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        content: "abc",
      },
    ]);
  });
});
