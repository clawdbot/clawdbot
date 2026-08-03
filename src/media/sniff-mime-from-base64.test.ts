// Base64 mime sniffing tests cover type inference from encoded media payloads.
import { describe, expect, it } from "vitest";
import { sniffMimeFromBase64 } from "./sniff-mime-from-base64.js";

describe("sniffMimeFromBase64", () => {
  it("rejects malformed base64 before MIME sniffing", async () => {
    await expect(sniffMimeFromBase64("not-base64!")).resolves.toBeUndefined();
  });

  it("sniffs valid canonical base64 payloads", async () => {
    const onePixelPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    await expect(sniffMimeFromBase64(onePixelPng)).resolves.toBe("image/png");
  });

  it("rejects MIME signatures shorter than two base64 quads", async () => {
    await expect(
      sniffMimeFromBase64(Buffer.from("BM").toString("base64")),
    ).resolves.toBeUndefined();
    await expect(
      sniffMimeFromBase64(Buffer.from([0xff, 0xd8, 0xff]).toString("base64")),
    ).resolves.toBeUndefined();
  });

  it("sniffs large base64 payloads from their prefix", async () => {
    const onePixelPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const png = Buffer.concat([Buffer.from(onePixelPng, "base64"), Buffer.alloc(1_900_000)]);

    await expect(sniffMimeFromBase64(png.toString("base64"))).resolves.toBe("image/png");
  });

  it("rejects malformed data after a valid MIME prefix", async () => {
    const onePixelPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    await expect(sniffMimeFromBase64(onePixelPng + "!")).resolves.toBeUndefined();
  });
});
