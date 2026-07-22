// Covers shared legacy config rule detection helpers.
import { afterEach, describe, expect, it } from "vitest";
import { mapLegacyAudioTranscription, mergeMissing } from "./legacy.shared.js";

describe("legacy audio transcription migration", () => {
  it("migrates deprecated input placeholders to the documented singular media path", () => {
    expect(
      mapLegacyAudioTranscription({
        command: ["whisper", "--file", "{input}", "--label={input}"],
      }),
    ).toEqual({
      type: "cli",
      command: "whisper",
      args: ["--file", "{{MediaPath}}", "--label={{MediaPath}}"],
    });
  });
});

describe("mergeMissing prototype pollution guard", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it("ignores __proto__ keys without polluting Object.prototype", () => {
    const target = { safe: { keep: true } } as Record<string, unknown>;
    const source = JSON.parse('{"safe":{"next":1},"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;

    mergeMissing(target, source);

    expect((target.safe as Record<string, unknown>).keep).toBe(true);
    expect((target.safe as Record<string, unknown>).next).toBe(1);
    expect(target.polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
