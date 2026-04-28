import { describe, expect, it } from "vitest";
import { transcodeAudioBuffer } from "./audio-transcode.js";

describe("transcodeAudioBuffer", () => {
  it("returns noop-same-container when source and target containers match", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: ".mp3",
    });
    expect(result).toEqual({ ok: false, reason: "noop-same-container" });
  });

  it("returns no-recipe when no afconvert recipe is defined for the requested pair", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "flac",
    });
    expect(result).toEqual({ ok: false, reason: "no-recipe" });
  });

  it("returns invalid-extension for an empty source extension", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "",
      targetExtension: "caf",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-extension" });
  });

  it("returns invalid-extension for an empty target extension", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-extension" });
  });

  it("rejects path-traversal style extensions", async () => {
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "../etc/passwd",
      targetExtension: "caf",
    });
    expect(result).toEqual({ ok: false, reason: "invalid-extension" });
  });

  it("returns platform-unsupported off-Darwin without invoking afconvert", async () => {
    if (process.platform === "darwin") {
      // macOS: a valid mp3→caf request would proceed to spawn `afconvert`,
      // which we don't want to run from a unit test. The Darwin happy path
      // is exercised end-to-end via the BlueBubbles voice-memo flow.
      return;
    }
    const result = await transcodeAudioBuffer({
      audioBuffer: Buffer.from("payload"),
      sourceExtension: "mp3",
      targetExtension: "caf",
    });
    expect(result).toEqual({ ok: false, reason: "platform-unsupported" });
  });
});
