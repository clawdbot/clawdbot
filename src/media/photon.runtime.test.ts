import photon from "@silvia-odwyer/photon-node";
import { expect, it } from "vitest";
import { convertBmpToPngWithPhoton } from "./photon.runtime.js";

it("keeps encoded BMP pixels intact after Photon cleanup and later conversions", () => {
  // Two 24-bit BMP pixels, red then green, followed by row padding.
  const bmp = Buffer.from(
    "424d3e00000000000000360000002800000002000000010000000100180000000000" +
      "08000000000000000000000000000000000000000000ff00ff000000",
    "hex",
  );
  const png = convertBmpToPngWithPhoton(bmp);
  const saved = Buffer.from(png);

  bmp.fill(0, 54);
  const later = convertBmpToPngWithPhoton(bmp);
  expect(later).not.toEqual(png);
  expect(png).toEqual(saved);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");

  const decoded = photon.PhotonImage.new_from_byteslice(png);
  try {
    expect([decoded.get_width(), decoded.get_height()]).toEqual([2, 1]);
    expect([...decoded.get_raw_pixels()]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  } finally {
    decoded.free();
  }
});
