import { describe, expect, expectTypeOf, it } from "vitest";
import { FormatCapabilityProfile } from "./text-chunking.js";

describe("FormatCapabilityProfile", () => {
  it("defaults constructs to native while preserving override literals", () => {
    const profile = FormatCapabilityProfile.define({
      mechanism: "ranges",
      constructs: {
        underline: "strip",
        spoiler: "fallback",
        codeLanguage: "strip",
        linkLabel: "fallback",
        heading: "fallback",
        bulletList: "fallback",
        orderedList: "fallback",
        taskList: "fallback",
        table: "strip",
        blockquote: "fallback",
        image: "strip",
      },
      chunk: { limit: 2_048, unit: "bytes", hardCap: 65_536 },
    });

    expectTypeOf(profile.mechanism).toEqualTypeOf<"ranges">();
    expectTypeOf(profile.constructs.bold).toEqualTypeOf<"native">();
    expectTypeOf(profile.constructs.underline).toEqualTypeOf<"strip">();
    expectTypeOf(profile.chunk.unit).toEqualTypeOf<"bytes">();
    expect(profile.constructs.bold).toBe("native");
    expect(profile.chunk.hardCap).toBe(65_536);
  });

  it("rejects unknown construct overrides", () => {
    type MisspelledProfile = {
      mechanism: "markdown";
      constructs: { table: "fallback"; blockqoute: "fallback" };
      chunk: { limit: number; unit: "chars" };
    };
    type AcceptsMisspelledProfile = typeof FormatCapabilityProfile.define extends (
      profile: MisspelledProfile,
    ) => unknown
      ? true
      : false;

    expectTypeOf<AcceptsMisspelledProfile>().toEqualTypeOf<false>();
  });
});
