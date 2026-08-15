import { describe, expect, it } from "vitest";
import { formatSignalMediaText } from "./media-text.js";

describe("formatSignalMediaText", () => {
  it("uses the shared formatter for one structured fact", () => {
    expect(formatSignalMediaText([{ kind: "audio", contentType: "audio/ogg" }])).toBe(
      "<media:audio>",
    );
  });

  it("preserves Signal's established multi-attachment summary", () => {
    expect(
      formatSignalMediaText([
        { kind: "image", contentType: "image/jpeg" },
        { kind: "document", contentType: "application/pdf" },
      ]),
    ).toBe("[1 image + 1 document attached]");
  });
});
