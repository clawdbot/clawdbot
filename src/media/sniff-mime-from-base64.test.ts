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
});
