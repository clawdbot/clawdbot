import { describe, expect, it } from "vitest";
import { resolveMirroredTranscriptText } from "./transcript-mirror.js";

describe("resolveMirroredTranscriptText", () => {
  it("keeps the message text when media is attached", () => {
    expect(
      resolveMirroredTranscriptText({
        text: "Revenue fell 12% quarter over quarter.",
        mediaUrls: ["https://example.com/files/chart-q3.png?token=abc"],
      }),
    ).toBe("Revenue fell 12% quarter over quarter.\nchart-q3.png");
  });

  it("joins multiple media names after the text", () => {
    expect(
      resolveMirroredTranscriptText({
        text: "See attachments",
        mediaUrls: ["https://example.com/a.png", "https://example.com/b.pdf"],
      }),
    ).toBe("See attachments\na.png, b.pdf");
  });

  it.each(["   /   ", "data:image/png;base64,aGVsbG8=", "data:text/plain,hello"])(
    "uses the media placeholder when %s has no filename",
    (mediaUrl) => {
      expect(resolveMirroredTranscriptText({ text: "hello", mediaUrls: [mediaUrl] })).toBe(
        "hello\nmedia",
      );
    },
  );

  it("returns media names alone when there is no text", () => {
    expect(
      resolveMirroredTranscriptText({ mediaUrls: ["https://example.com/voice-note.ogg"] }),
    ).toBe("voice-note.ogg");
  });

  it("returns the placeholder alone for unnamed media without text", () => {
    expect(resolveMirroredTranscriptText({ text: "  ", mediaUrls: ["   /   "] })).toBe("media");
  });

  it("returns trimmed text when there is no media", () => {
    expect(resolveMirroredTranscriptText({ text: "  hi  ", mediaUrls: [] })).toBe("hi");
  });

  it("returns null when both text and media are empty", () => {
    expect(resolveMirroredTranscriptText({ text: "   ", mediaUrls: ["  "] })).toBeNull();
  });
});
