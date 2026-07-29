// Whatsapp tests cover outbound media canonicalization behavior.
import { describe, expect, it } from "vitest";
import { prepareWhatsAppOutboundMedia } from "./outbound-media-contract.js";

describe("prepareWhatsAppOutboundMedia", () => {
  it("labels ogg audio as a voice note when only the file name reveals the container", async () => {
    const prepared = await prepareWhatsAppOutboundMedia(
      {
        buffer: Buffer.from("fake-opus-bytes"),
        contentType: "audio/mpeg",
        fileName: "voice.ogg",
        kind: "audio",
      },
      "https://example.com/download?id=42",
    );

    expect(prepared.mimetype).toBe("audio/ogg; codecs=opus");
  });
});
