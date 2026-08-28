import { describe, expect, it } from "vitest";
import { hasCotFramePrefix } from "./cot-frame.js";

describe("hasCotFramePrefix", () => {
  describe("matches bracketed internal narration frames", () => {
    it("matches default internal labels", () => {
      expect(hasCotFramePrefix("[internal] thinking out loud")).toBe(true);
      expect(hasCotFramePrefix("[analysis] planning next step")).toBe(true);
      expect(hasCotFramePrefix("[chain of thought] private reasoning")).toBe(true);
    });

    it("matches configured speaker labels without hardcoding deployment identities", () => {
      expect(
        hasCotFramePrefix("[reviewer-a] private narration", {
          speakerLabels: ["reviewer-a"],
        }),
      ).toBe(true);
    });

    it("is case-insensitive on the frame label", () => {
      expect(hasCotFramePrefix("[INTERNAL] thinking")).toBe(true);
      expect(hasCotFramePrefix("[Reasoning] thinking")).toBe(true);
    });

    it("matches with zero whitespace after closing bracket", () => {
      expect(hasCotFramePrefix("[internal]leak")).toBe(true);
    });

    it("matches with leading whitespace before the frame", () => {
      expect(hasCotFramePrefix("   [internal] indented thinking")).toBe(true);
      expect(hasCotFramePrefix("\n[analysis] after newline")).toBe(true);
    });

    it("matches only-prefix-no-body", () => {
      expect(hasCotFramePrefix("[internal]")).toBe(true);
      expect(hasCotFramePrefix("[internal] ")).toBe(true);
    });
  });

  describe("rejects non-CoT-frame text", () => {
    it("rejects empty string", () => {
      expect(hasCotFramePrefix("")).toBe(false);
    });

    it("rejects normal replies", () => {
      expect(hasCotFramePrefix("Normal user reply")).toBe(false);
    });

    it("rejects body-pure replies that start with punctuation", () => {
      expect(hasCotFramePrefix("* important body-pure reply")).toBe(false);
    });

    it("rejects frames that are not at the start", () => {
      expect(hasCotFramePrefix("Some text [internal] not-at-start")).toBe(false);
    });

    it("does not flag [user] / [system] / [assistant] (common English)", () => {
      expect(hasCotFramePrefix("[user] reported a bug")).toBe(false);
      expect(hasCotFramePrefix("[system] ready")).toBe(false);
      expect(hasCotFramePrefix("[assistant] replied")).toBe(false);
    });

    it("does not flag unrelated bracketed tokens", () => {
      expect(hasCotFramePrefix("[info] starting")).toBe(false);
      expect(hasCotFramePrefix("[todo] fix later")).toBe(false);
      expect(hasCotFramePrefix("[reviewer-a] visible reply")).toBe(false);
    });

    it("does not flag partial internal-label matches", () => {
      expect(hasCotFramePrefix("[internalization] reply")).toBe(false);
      expect(hasCotFramePrefix("[analysisfoo] reply")).toBe(false);
    });
  });
});
