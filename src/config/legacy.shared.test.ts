// Covers shared legacy config rule detection helpers.
import { afterEach, describe, expect, it } from "vitest";
import { mapLegacyAudioTranscription } from "./legacy.shared.js";
import { mergeMissing } from "./merge-missing.js";

describe("legacy audio transcription migration", () => {
  it("migrates deprecated input placeholders to the documented attachment path", () => {
    expect(
      mapLegacyAudioTranscription({
        command: ["whisper", "--file", "{input}", "--label={input}"],
      }),
    ).toEqual({
      type: "cli",
      command: "whisper",
      args: ["--file", "{{AttachmentPath}}", "--label={{AttachmentPath}}"],
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

  it.each(["__proto__", "prototype", "constructor"])(
    "keeps an explicitly missing %s key untouched at each merged level",
    (key) => {
      const nested = { [key]: undefined, keep: true };
      const target: Record<string, unknown> = { [key]: undefined, nested };
      const source = {
        [key]: { polluted: true },
        nested: { [key]: { polluted: true }, next: 1 },
      };

      mergeMissing(target, source);

      expect(target[key]).toBeUndefined();
      expect(target.nested).toEqual({ [key]: undefined, keep: true, next: 1 });
      expect(target.nested).toBe(nested);
    },
  );

  it("fills missing fields by reference while preserving authored values and records", () => {
    const inserted = { value: 1 };
    const nested = { keep: "canonical" };
    const array = ["canonical"];
    const target: Record<string, unknown> = {
      nested,
      array,
      nil: null,
      zero: 0,
      disabled: false,
      empty: "",
    };
    const source = {
      missing: inserted,
      nested: { keep: "legacy", added: inserted },
      array: ["legacy"],
      nil: { value: 2 },
      zero: 3,
      disabled: true,
      empty: "legacy",
      omitted: undefined,
    };

    mergeMissing(target, source);

    expect(target).toEqual({
      nested: { keep: "canonical", added: inserted },
      array: ["canonical"],
      nil: null,
      zero: 0,
      disabled: false,
      empty: "",
      missing: inserted,
    });
    expect(target.missing).toBe(inserted);
    expect(target.nested).toBe(nested);
    expect(target.nested).toHaveProperty("added", inserted);
    expect(target.array).toBe(array);
    expect(Object.hasOwn(target, "omitted")).toBe(false);
  });
});
