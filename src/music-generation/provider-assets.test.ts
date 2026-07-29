import { describe, expect, it } from "vitest";
import { generatedMusicAssetFromBase64 } from "./provider-assets.js";

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
