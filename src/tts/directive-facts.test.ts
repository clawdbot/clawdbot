import { describe, expect, it } from "vitest";
import { extractTtsDirectiveFacts } from "./directive-facts.js";

describe("extractTtsDirectiveFacts", () => {
  describe("[[tts:<free text>]] (no key=value directive)", () => {
    it("preserves the spoken reply body instead of discarding it (#137281)", () => {
      // gpt-5.6 reads the inbound TTS hint as "wrap the reply in the tag" and
      // emits the spoken reply as the directive body.
      const result = extractTtsDirectiveFacts("[[tts:Yes—I understand you clearly now.]]");
      expect(result.cleanedText).toBe("Yes—I understand you clearly now.");
      expect(result.facts).toEqual({
        tagged: true,
        text: "Yes—I understand you clearly now.",
      });
    });

    it("preserves a multi-word free-text body and marks it tagged", () => {
      const result = extractTtsDirectiveFacts("[[tts:hello world]]");
      expect(result.cleanedText).toBe("hello world");
      expect(result.facts?.tagged).toBe(true);
      expect(result.facts?.text).toBe("hello world");
    });

    it("preserves the free-text body when it appears inside surrounding prose", () => {
      const result = extractTtsDirectiveFacts("Sure! [[tts:On my way now.]]");
      expect(result.cleanedText).toBe("Sure! On my way now.");
      expect(result.facts?.text).toBe("On my way now.");
    });

    it("does not treat a whitespace-only body as spoken text", () => {
      const result = extractTtsDirectiveFacts("[[tts:   ]]");
      // No key=value tokens and no non-empty body -> nothing to speak, tag is
      // still recorded but no reply text is synthesized.
      expect(result.cleanedText).toBe("");
      expect(result.facts?.tagged).toBe(true);
      expect(result.facts?.text).toBeUndefined();
    });
  });

  describe("key=value directives (unchanged behavior)", () => {
    it("strips a single key=value directive and records it", () => {
      const result = extractTtsDirectiveFacts("[[tts:speed=1.5]]");
      expect(result.cleanedText).toBe("");
      expect(result.facts?.tagged).toBe(true);
      expect(result.facts?.text).toBeUndefined();
      expect(result.facts?.directives).toEqual([{ values: { speed: "1.5" } }]);
    });

    it("strips a provider directive with extra values", () => {
      const result = extractTtsDirectiveFacts("[[tts:provider=openai speed=1.2]]");
      expect(result.cleanedText).toBe("");
      expect(result.facts?.text).toBeUndefined();
      expect(result.facts?.directives).toEqual([{ provider: "openai", values: { speed: "1.2" } }]);
    });

    it("keeps surrounding visible text when a directive is stripped", () => {
      const result = extractTtsDirectiveFacts("hello [[tts:provider=minimax speed=1.2]] world");
      expect(result.cleanedText).toBe("hello  world");
      expect(result.facts?.directives).toEqual([{ provider: "minimax", values: { speed: "1.2" } }]);
    });
  });

  describe("[[tts:text]]...[[/tts:text]] block (unchanged behavior)", () => {
    it("carries the inner text as the spoken reply", () => {
      const result = extractTtsDirectiveFacts("[[tts:text]]on my way[[/tts:text]]");
      expect(result.cleanedText).toBe("");
      expect(result.facts?.text).toBe("on my way");
    });
  });

  describe("text without TTS markup", () => {
    it("returns the input untouched with no facts", () => {
      const result = extractTtsDirectiveFacts("just a plain reply");
      expect(result.cleanedText).toBe("just a plain reply");
      expect(result.facts).toBeUndefined();
    });
  });
});
