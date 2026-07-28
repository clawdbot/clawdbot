// Outbound media kind inference: a buffer with a real fileName but no contentType must be
// classified by its filename extension, not sent as a generic document (regression).
import { describe, expect, it } from "vitest";
import { prepareWhatsAppOutboundMedia } from "./outbound-media-contract.js";

describe("prepareWhatsAppOutboundMedia kind inference from filename", () => {
  it("classifies a buffer video by extension when contentType is absent", async () => {
    const result = await prepareWhatsAppOutboundMedia({
      buffer: Buffer.from("x"),
      fileName: "clip.mp4",
    });
    expect(result.kind).toBe("video");
  });

  it("classifies a buffer image by extension when contentType is absent", async () => {
    const result = await prepareWhatsAppOutboundMedia({
      buffer: Buffer.from("x"),
      fileName: "photo.png",
    });
    expect(result.kind).toBe("image");
  });

  it("uses the native voice mimetype for an audio buffer named .ogg (not octet-stream)", async () => {
    const result = await prepareWhatsAppOutboundMedia({
      buffer: Buffer.from("x"),
      kind: "audio",
      fileName: "voice.ogg",
    });
    expect(result.kind).toBe("audio");
    expect(result.mimetype).toMatch(/ogg|opus/i);
  });
});
