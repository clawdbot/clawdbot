import { describe, expect, it } from "vitest";
import {
  invalidInlineImageText,
  sanitizeCodexHistoryImagePayloads,
  sanitizeInlineImageDataUrl,
} from "./image-payload-sanitizer.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

describe("Codex app-server image payload sanitizer", () => {
  it("drops malformed data URL image payloads", () => {
    expect(sanitizeInlineImageDataUrl("data:image/jpeg;base64,not base64!")).toBeUndefined();
  });

  it("canonicalizes valid data URL images with sniffed MIME type", () => {
    expect(sanitizeInlineImageDataUrl(`data:image/jpeg;base64,\n${PNG_1X1}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
  });

  it("formats the text replacement used for invalid images", () => {
    expect(invalidInlineImageText("codex user input")).toContain("invalid inline image data");
  });

  it("scrubs invalid image blocks from mirrored history values", () => {
    expect(
      sanitizeCodexHistoryImagePayloads(
        [
          {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/jpeg", data: "not base64!" }],
          },
        ],
        "codex mirrored history",
      ),
    ).toEqual([
      {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: "[codex mirrored history] omitted image payload: invalid inline image data",
          },
        ],
      },
    ]);
  });
});
