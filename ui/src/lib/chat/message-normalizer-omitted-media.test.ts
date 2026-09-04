// @vitest-environment node
// Control UI tests cover omitted historical media normalization.
import { describe, expect, it } from "vitest";
import { normalizeMessage } from "./message-normalizer.ts";

describe("message-normalizer omitted historical media", () => {
  it("preserves omitted historical images as non-recoverable media placeholders", () => {
    const result = normalizeMessage({
      role: "user",
      content: [{ type: "image", omitted: true, bytes: 12 * 1024 }],
    });

    expect(result.content).toEqual([
      {
        type: "omitted_media",
        media: {
          kind: "image",
          sizeBytes: 12 * 1024,
        },
      },
    ]);
  });

  it.each([
    ["missing", undefined],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["string", "12288"],
  ])(
    "omits %s byte metadata without dropping the historical image placeholder",
    (_label, bytes) => {
      const result = normalizeMessage({
        role: "user",
        content: [{ type: "image", omitted: true, ...(bytes === undefined ? {} : { bytes }) }],
      });

      expect(result.content).toEqual([
        {
          type: "omitted_media",
          media: { kind: "image" },
        },
      ]);
    },
  );

  it("does not treat ordinary image blocks as omitted media", () => {
    const result = normalizeMessage({
      role: "user",
      content: [{ type: "image", omitted: false, bytes: 12 * 1024 }],
    });

    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "omitted_media" }));
  });

  it("does not add an omitted-media placeholder when a renderable URL remains", () => {
    const result = normalizeMessage({
      role: "user",
      content: [
        {
          type: "image",
          omitted: true,
          bytes: 12 * 1024,
          url: "https://files.example/history-image.png",
        },
      ],
    });

    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "omitted_media" }));
  });

  it.each([
    { type: "input_image", omitted: true, bytes: 26 },
    { type: "input_image", omitted: true, bytes: 27, image_url: { detail: "high" } },
    {
      type: "input_image",
      omitted: true,
      bytes: 16,
      source: { media_type: "image/png" },
    },
    { type: "input_image", omitted: true, bytes: 26, file_id: "file-image" },
  ])("normalizes omitted Responses images into the shared placeholder", (block) => {
    const result = normalizeMessage({ role: "assistant", content: [block] });

    expect(result.content).toEqual([
      {
        type: "omitted_media",
        media: { kind: "image", sizeBytes: block.bytes },
      },
    ]);
  });

  it.each([
    { image_url: "https://files.example/history-image.png" },
    { image_url: { url: "https://files.example/history-image.png" } },
    { source: { url: "https://files.example/history-image.png" } },
    { source: { data: "remaining-inline-data", media_type: "image/png" } },
  ])("does not add a placeholder when a Responses image source remains", (source) => {
    const result = normalizeMessage({
      role: "assistant",
      content: [{ type: "input_image", omitted: true, bytes: 26, ...source }],
    });

    expect(result.content).not.toContainEqual(expect.objectContaining({ type: "omitted_media" }));
  });

  it("normalizes omitted Responses images nested in tool results", () => {
    const result = normalizeMessage({
      role: "assistant",
      content: [
        {
          type: "toolResult",
          id: "image-call",
          content: [{ type: "input_image", omitted: true, bytes: 26 }],
        },
      ],
    });

    expect(result.content).toContainEqual({
      type: "omitted_media",
      media: { kind: "image", sizeBytes: 26 },
    });
  });
});
