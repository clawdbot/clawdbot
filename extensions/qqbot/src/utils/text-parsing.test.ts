import { describe, expect, it, vi } from "vitest";
import { parseFaceTags } from "./text-parsing.js";

describe("parseFaceTags", () => {
  it("returns empty string when input is undefined", () => {
    expect(parseFaceTags(undefined)).toBe("");
  });

  it("returns empty string when input is null", () => {
    expect(parseFaceTags(null)).toBe("");
  });

  it("returns empty string when input is empty string", () => {
    expect(parseFaceTags("")).toBe("");
  });

  it("skips oversized base64 ext payloads before decoding", () => {
    const oversizedBase64 = "A".repeat(100_000);
    const tag = `<faceType=1,faceId="1",ext="${oversizedBase64}">`;
    const bufferFromSpy = vi.spyOn(Buffer, "from");

    try {
      expect(parseFaceTags(tag)).toBe("[Emoji: unknown emoji]");
      expect(bufferFromSpy).not.toHaveBeenCalledWith(oversizedBase64, "base64");
    } finally {
      bufferFromSpy.mockRestore();
    }
  });
});
