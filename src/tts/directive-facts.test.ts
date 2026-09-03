import { describe, expect, it } from "vitest";
import { extractTtsDirectiveFacts } from "./directive-facts.js";

describe("extractTtsDirectiveFacts", () => {
  it("keeps text unchanged when there is no TTS markup", () => {
    expect(extractTtsDirectiveFacts("plain prose")).toEqual({ cleanedText: "plain prose" });
  });

  it("records key=value directives and strips the tag from visible text", () => {
    const result = extractTtsDirectiveFacts("hello [[tts:provider=x voice=a]] world");
    expect(result.cleanedText).toBe("hello  world");
    expect(result.facts).toEqual({
      tagged: true,
      directives: [{ provider: "x", values: { voice: "a" } }],
    });
  });

  it("preserves a free-text [[tts:<prose>]] body as visible and spoken text", () => {
    const result = extractTtsDirectiveFacts("[[tts:Yes—I understand you clearly now.]]");
    expect(result.cleanedText).toBe("Yes—I understand you clearly now.");
    expect(result.facts).toEqual({
      tagged: true,
      text: "Yes—I understand you clearly now.",
    });
  });

  it("keeps free-text prose surrounding a preserved directive body", () => {
    const result = extractTtsDirectiveFacts("Go [[tts:hello world]] and return");
    expect(result.cleanedText).toBe("Go hello world and return");
    expect(result.facts?.text).toBe("hello world");
  });

  it("preserves a multiline free-text [[tts:...]] body", () => {
    const result = extractTtsDirectiveFacts("[[tts:first line\nsecond line]] tail");
    expect(result.cleanedText).toBe("first line\nsecond line tail");
    expect(result.facts).toEqual({
      tagged: true,
      text: "first line\nsecond line",
    });
  });

  it("trims a leading newline after [[tts:]] in the parser body", () => {
    const result = extractTtsDirectiveFacts("Go [[tts:\nhello]] now");
    expect(result.cleanedText).toBe("Go hello now");
    expect(result.facts?.text).toBe("hello");
  });

  it("still hides tts:text private blocks from the visible text", () => {
    const result = extractTtsDirectiveFacts("A [[tts:text]]whisper[[/tts:text]] Z");
    expect(result.cleanedText).toBe("A  Z");
    expect(result.facts).toEqual({ tagged: true, text: "whisper" });
  });

  it("keeps a lone [[tts:text]] marker audio-only instead of surfacing literal text", () => {
    const result = extractTtsDirectiveFacts("[[tts:text]]");
    expect(result.cleanedText).toBe("");
    expect(result.facts).toEqual({ tagged: true });
  });

  it("drops a lone [[tts:text]] marker but keeps the surrounding prose visible", () => {
    const result = extractTtsDirectiveFacts("say hi [[tts:text]] now");
    expect(result.cleanedText).toBe("say hi  now");
    expect(result.facts).toEqual({ tagged: true });
  });

  it("leaves single bare tts tags only tagged without silently dropping prose", () => {
    const result = extractTtsDirectiveFacts("[[tts]] read this aloud");
    expect(result.cleanedText).toBe(" read this aloud");
    expect(result.facts?.tagged).toBe(true);
  });
});
