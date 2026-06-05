// Common tool helper tests cover shared parsing and media result shapes used by
// multiple agent tools.
import { describe, expect, test } from "vitest";
import { imageResult, parseAvailableTags } from "./common.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wn8n0sAAAAASUVORK5CYII=";

describe("parseAvailableTags", () => {
  test("returns undefined for non-array inputs", () => {
    expect(parseAvailableTags(undefined)).toBeUndefined();
    expect(parseAvailableTags(null)).toBeUndefined();
    expect(parseAvailableTags("oops")).toBeUndefined();
  });

  test("drops entries without a string name and returns undefined when empty", () => {
    expect(parseAvailableTags([{ id: "1" }])).toBeUndefined();
    expect(parseAvailableTags([{ name: 123 }])).toBeUndefined();
  });

  test("keeps falsy ids and sanitizes emoji fields", () => {
    const result = parseAvailableTags([
      { id: "0", name: "General", emoji_id: null },
      { id: "1", name: "Docs", emoji_name: "📚" },
      { name: "Bad", emoji_id: 123 },
    ]);
    expect(result).toEqual([
      { id: "0", name: "General", emoji_id: null },
      { id: "1", name: "Docs", emoji_name: "📚" },
      { name: "Bad" },
    ]);
  });
});
describe("imageResult", () => {
  test("stores media delivery in details.media instead of MEDIA text", async () => {
    // Binary media should travel through typed content/details, not a textual
    // MEDIA sentinel that providers can display or reinterpret.
    const result = await imageResult({
      label: "test:image",
      path: "/tmp/test.png",
      base64: PNG_1X1_BASE64,
      mimeType: "image/png",
    });

    expect(result.content).toEqual([
      {
        type: "image",
        data: PNG_1X1_BASE64,
        mimeType: "image/png",
      },
    ]);
    expect(result.details).toEqual({
      path: "/tmp/test.png",
      media: {
        mediaUrl: "/tmp/test.png",
      },
    });
  });

  test("keeps extra text without MEDIA text fallback", async () => {
    const result = await imageResult({
      label: "test:image",
      path: "/tmp/test.png",
      base64: PNG_1X1_BASE64,
      mimeType: "image/png",
      extraText: "label text",
    });

    expect(result.content?.[0]).toEqual({
      type: "text",
      text: "label text",
    });
    expect(result.content?.[1]).toEqual({
      type: "image",
      data: PNG_1X1_BASE64,
      mimeType: "image/png",
    });
    expect(JSON.stringify(result.content)).not.toContain("MEDIA:");
  });
});
