import { describe, expect, it } from "vitest";
import { renderCatFacePngBase64 } from "./live-image-probe.js";

describe("live image probe", () => {
  it("leaves room for the unclipped bottom CAT label", () => {
    const png = Buffer.from(renderCatFacePngBase64(), "base64");

    expect(png.toString("ascii", 1, 4)).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(256);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(274);
  });
});
