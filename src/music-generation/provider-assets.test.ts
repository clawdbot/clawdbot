import { describe, expect, it, vi } from "vitest";
import { downloadGeneratedMusicAsset, generatedMusicAssetFromBase64 } from "./provider-assets.js";

describe("generatedMusicAssetFromBase64", () => {
  it.each([
    ["invalid alphabet", "not-base64!"],
    ["non-canonical pad bits", "ZE=="],
  ])("rejects %s", (_scenario, base64) => {
    expect(() => generatedMusicAssetFromBase64({ base64, mimeType: "audio/mpeg" })).toThrow(
      "Generated music asset contains malformed base64 audio data",
    );
  });
});

describe("downloadGeneratedMusicAsset", () => {
  it("preserves custom response MIME types and optional source metadata", async () => {
    const release = vi.fn(async () => undefined);
    const asset = await downloadGeneratedMusicAsset({
      candidate: { url: "https://cdn.example/track" },
      timeoutMs: 1_000,
      fetchFn: fetch,
      provider: "Example",
      requestFailedMessage: "Example generated music download failed",
      includeSourceUrl: false,
      fetchResponse: async () => ({
        response: new Response(new Uint8Array([1, 2, 3])),
        mimeType: "application/octet-stream",
        release,
      }),
    });

    expect(asset).toMatchObject({
      buffer: Buffer.from([1, 2, 3]),
      mimeType: "application/octet-stream",
      fileName: "track-1.mp3",
    });
    expect(asset.metadata).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
