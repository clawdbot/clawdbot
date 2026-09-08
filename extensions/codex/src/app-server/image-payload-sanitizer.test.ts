// Codex tests cover image payload sanitizer plugin behavior.
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

  it("reuses unchanged history including canonical images and unknown nested values", () => {
    const history = Object.freeze([
      Object.freeze({
        role: "user",
        content: Object.freeze([
          Object.freeze({ type: "text", text: "preserved context" }),
          Object.freeze({ type: "image", mimeType: "image/png", data: PNG_1X1 }),
          Object.freeze({ type: "inputImage", imageUrl: `data:image/png;base64,${PNG_1X1}` }),
          Object.freeze({ type: "input_image", image_url: "https://example.com/image.png" }),
        ]),
        metadata: Object.freeze({ nested: Object.freeze([null, 1, true, Object.freeze({})]) }),
      }),
    ]);

    // Re-reading an unchanged transcript must not copy its whole object graph.
    expect(sanitizeCodexHistoryImagePayloads(history, "history")).toBe(history);
  });

  it.each([
    {
      name: "invalid image",
      image: { type: "image", mimeType: "image/jpeg", data: "not base64!" },
      expected: { type: "text", text: invalidInlineImageText("history") },
    },
    {
      name: "normalized image",
      image: { type: "image", mimeType: "image/jpeg", data: `\n${PNG_1X1}`, extra: "kept" },
      expected: { type: "image", mimeType: "image/png", data: PNG_1X1, extra: "kept" },
    },
    {
      name: "invalid inputImage",
      image: { type: "inputImage", imageUrl: "data:image/png;base64,invalid!" },
      expected: { type: "inputText", text: invalidInlineImageText("history") },
    },
    {
      name: "normalized inputImage",
      image: { type: "inputImage", imageUrl: `data:image/jpeg;base64,${PNG_1X1}` },
      expected: { type: "inputImage", imageUrl: `data:image/png;base64,${PNG_1X1}` },
    },
    {
      name: "invalid input_image",
      image: { type: "input_image", image_url: "data:image/png;base64,invalid!" },
      expected: { type: "input_text", text: invalidInlineImageText("history") },
    },
    {
      name: "normalized input_image",
      image: { type: "input_image", image_url: `data:image/jpeg;base64,${PNG_1X1}` },
      expected: { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` },
    },
  ])("copies only changed ancestors of an $name without mutating input", ({ image, expected }) => {
    const content = Object.freeze([Object.freeze({ type: "text", text: "kept" })]);
    const unchanged = Object.freeze({ role: "user", content: "unchanged" });
    const message = Object.freeze({
      role: "toolResult",
      content,
      details: Object.freeze({ unknown: Object.freeze([Object.freeze(image)]) }),
    });
    const history = Object.freeze([message, unchanged]);
    const before = structuredClone(history);

    const sanitized = sanitizeCodexHistoryImagePayloads(history, "history");

    expect(sanitized).not.toBe(history);
    expect(sanitized[0]).not.toBe(message);
    expect(sanitized[0]).toEqual({ ...message, details: { unknown: [expected] } });
    expect(sanitized[0]?.content).toBe(content);
    expect(sanitized[1]).toBe(unchanged);
    expect(history).toEqual(before);
    expect(sanitizeCodexHistoryImagePayloads(sanitized, "history")).toBe(sanitized);
  });
});
