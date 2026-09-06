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
});
