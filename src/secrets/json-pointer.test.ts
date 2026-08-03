/** Tests JSON Pointer helpers used by file-backed secret refs. */
import { describe, expect, it } from "vitest";
import { readJsonPointer } from "./json-pointer.js";

describe("readJsonPointer", () => {
  it("rejects partial array index segments", () => {
    const root = { items: ["zero", "one"] };

    expect(readJsonPointer(root, "/items/1abc", { onMissing: "undefined" })).toBeUndefined();
    expect(() => readJsonPointer(root, "/items/1abc")).toThrow(
      /JSON pointer segment "1abc" is out of bounds/,
    );
  });

  it("rejects unsafe array index segments", () => {
    const root = { items: ["zero", "one"] };

    expect(
      readJsonPointer(root, "/items/9007199254740993", { onMissing: "undefined" }),
    ).toBeUndefined();
  });

  it("rejects signed array index segments", () => {
    const root = { items: ["zero", "one"] };

    expect(readJsonPointer(root, "/items/+0", { onMissing: "undefined" })).toBeUndefined();
  });
});
