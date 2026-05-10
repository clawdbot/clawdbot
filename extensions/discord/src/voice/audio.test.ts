import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { decodeOpusStream, resolveOpusDecoderPreference } from "./audio.js";

describe("discord voice opus decoder selection", () => {
  it("defaults to the pure-JS opusscript decoder", async () => {
    const verbose: string[] = [];
    const warnings: string[] = [];
    const previousPreference = process.env.OPENCLAW_DISCORD_OPUS_DECODER;
    delete process.env.OPENCLAW_DISCORD_OPUS_DECODER;

    try {
      const decoded = await decodeOpusStream(Readable.from([]), {
        onVerbose: (message) => verbose.push(message),
        onWarn: (message) => warnings.push(message),
      });

      expect(decoded.length).toBe(0);
      expect(verbose).toContain("opus decoder: opusscript");
      expect(warnings).toEqual([]);
    } finally {
      if (previousPreference === undefined) {
        delete process.env.OPENCLAW_DISCORD_OPUS_DECODER;
      } else {
        process.env.OPENCLAW_DISCORD_OPUS_DECODER = previousPreference;
      }
    }
  });

  it("requires an explicit preference for native opus", () => {
    expect(resolveOpusDecoderPreference()).toBe("opusscript");
    expect(resolveOpusDecoderPreference("opusscript")).toBe("opusscript");
    expect(resolveOpusDecoderPreference("native")).toBe("native");
    expect(resolveOpusDecoderPreference("@discordjs/opus")).toBe("native");
  });
});
