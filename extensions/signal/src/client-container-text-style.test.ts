import { describe, expect, it } from "vitest";
import { parseContainerTextStyleEntry } from "./client-container-text-style.js";

describe("parseContainerTextStyleEntry", () => {
  it("rejects hex start token", () => {
    expect(parseContainerTextStyleEntry("0x10:4:ITALIC")).toBeUndefined();
  });

  it("rejects hex length token", () => {
    expect(parseContainerTextStyleEntry("0:0x4:BOLD")).toBeUndefined();
  });

  it("rejects exponent start token", () => {
    expect(parseContainerTextStyleEntry("1e1:2:BOLD")).toBeUndefined();
  });

  it("rejects exponent length token", () => {
    expect(parseContainerTextStyleEntry("0:1e0:BOLD")).toBeUndefined();
  });

  it("rejects fractional start token", () => {
    expect(parseContainerTextStyleEntry("0.5:4:BOLD")).toBeUndefined();
  });

  it("rejects fractional length token", () => {
    expect(parseContainerTextStyleEntry("0:1.5:BOLD")).toBeUndefined();
  });

  it("rejects negative start token", () => {
    expect(parseContainerTextStyleEntry("-1:4:BOLD")).toBeUndefined();
  });

  it("rejects negative length token", () => {
    expect(parseContainerTextStyleEntry("0:-4:BOLD")).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(parseContainerTextStyleEntry("")).toBeUndefined();
  });

  it("rejects single token (no length or style)", () => {
    expect(parseContainerTextStyleEntry("0")).toBeUndefined();
  });

  it("rejects two tokens (no style)", () => {
    expect(parseContainerTextStyleEntry("0:4")).toBeUndefined();
  });

  it("rejects missing start (empty before first colon)", () => {
    expect(parseContainerTextStyleEntry(":4:BOLD")).toBeUndefined();
  });

  it("parses valid decimal BOLD span", () => {
    expect(parseContainerTextStyleEntry("0:4:BOLD")).toEqual({
      start: 0,
      length: 4,
      style: "BOLD",
    });
  });

  it("parses valid decimal ITALIC span", () => {
    expect(parseContainerTextStyleEntry("5:2:ITALIC")).toEqual({
      start: 5,
      length: 2,
      style: "ITALIC",
    });
  });

  it("parses STRIKETHROUGH span", () => {
    expect(parseContainerTextStyleEntry("10:5:STRIKETHROUGH")).toEqual({
      start: 10,
      length: 5,
      style: "STRIKETHROUGH",
    });
  });

  it("parses MONOSPACE span", () => {
    expect(parseContainerTextStyleEntry("3:1:MONOSPACE")).toEqual({
      start: 3,
      length: 1,
      style: "MONOSPACE",
    });
  });

  it("parses zero-length span (allowed by protocol)", () => {
    expect(parseContainerTextStyleEntry("0:0:BOLD")).toEqual({
      start: 0,
      length: 0,
      style: "BOLD",
    });
  });

  it("parses zero-start span", () => {
    expect(parseContainerTextStyleEntry("0:4:BOLD")).toEqual({
      start: 0,
      length: 4,
      style: "BOLD",
    });
  });

  it("drops extra colon-separated parts beyond start:length:style", () => {
    const result = parseContainerTextStyleEntry("0:4:BOLD:extra");
    expect(result).toEqual({ start: 0, length: 4, style: "BOLD" });
  });

  it.each([
    "0x10:4:ITALIC",
    "1e1:2:BOLD",
    "0x0:0x4:BOLD",
    "1e0:4:BOLD",
    "0:1.5:BOLD",
    "0x10:4",
    ":4:BOLD",
  ])("rejects malformed input %j", (raw) => {
    expect(parseContainerTextStyleEntry(raw)).toBeUndefined();
  });

  it.each([
    ["0:4:BOLD", 0, 4, "BOLD"],
    ["5:2:ITALIC", 5, 2, "ITALIC"],
    ["10:5:STRIKETHROUGH", 10, 5, "STRIKETHROUGH"],
    ["0:0:BOLD", 0, 0, "BOLD"],
    ["3:1:MONOSPACE", 3, 1, "MONOSPACE"],
    ["7:3:SPOILER", 7, 3, "SPOILER"],
  ] as const)("parses %j → start=%d length=%d style=%s", (raw, start, length, style) => {
    expect(parseContainerTextStyleEntry(raw)).toEqual({ start, length, style });
  });
});
