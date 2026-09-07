// Tool image input-cap tests verify pathological oversized base64 input is
// rejected before Buffer.from allocates a transient multi-MB buffer.
import { describe, expect, it } from "vitest";
import { sanitizeContentBlocksImages } from "./tool-images.js";

const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;

describe("tool image sanitizer oversized input cap", () => {
  it("rejects oversized estimated input before decode allocation", async () => {
    const encodedLength = Math.ceil(((MAX_IMAGE_INPUT_BYTES + 1) * 4) / 3 / 4) * 4;
    const oversizedBase64 = "A".repeat(encodedLength);

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: oversizedBase64, mimeType: "image/png" }],
      "test",
    );

    expect(out).toStrictEqual([
      {
        type: "text",
        text: "[test] omitted image payload: image exceeds input size limit (10.00MB)",
      },
    ]);
  });
});
