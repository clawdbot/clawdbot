import { describe, expect, it } from "vitest";
import { decodeMountInfoPath } from "./mountinfo-path.js";

describe("decodeMountInfoPath", () => {
  it("decodes the four characters escaped by Linux mount tables", () => {
    expect(decodeMountInfoPath(String.raw`/one\040two\011tab\012line\134slash`)).toBe(
      "/one two\ttab\nline\\slash",
    );
  });
});
