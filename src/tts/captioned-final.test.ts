import { describe, expect, it } from "vitest";
import { cleanDeferredFinalText, mergeDeferredFinalText } from "./captioned-final.js";

describe("mergeDeferredFinalText", () => {
  it("keeps identical and cumulative final text once", () => {
    expect(mergeDeferredFinalText("hello", "hello")).toBe("hello");
    expect(mergeDeferredFinalText("hello", "hello world")).toBe("hello world");
    expect(mergeDeferredFinalText("hello world", "hello")).toBe("hello world");
  });

  it("keeps distinct streamed and final text", () => {
    expect(mergeDeferredFinalText("first", "second")).toBe("first\nsecond");
  });
});

describe("cleanDeferredFinalText", () => {
  it.each([
    "Literal `[[tts:Yes—I understand you clearly now.]]` code.",
    "```text\n[[tts:text]]private example[[/tts:text]]\n[[tts:voice=alice]]\n```",
    "    [[tts:Yes—I understand you clearly now.]]",
    "```text\n[[tts:text]]unfinished code example",
  ])("preserves literal code in the caption: %s", (input) => {
    expect(cleanDeferredFinalText(input)).toBe(input);
  });

  it("keeps TTS-only text out of the visible final", () => {
    expect(cleanDeferredFinalText("Visible. [[tts:text]]Private speech.[[/tts:text]] Done.")).toBe(
      "Visible.  Done.",
    );
  });

  it("preserves a free-text [[tts:...]] body instead of emptying the visible final", () => {
    expect(cleanDeferredFinalText("Visible [[tts:Yes—I understand you clearly now.]] done")).toBe(
      "Visible Yes—I understand you clearly now. done",
    );
  });

  it("still strips key=value directives from the deferred visible final", () => {
    expect(cleanDeferredFinalText("say [[tts:voice=alice]] now")).toBe("say  now");
  });

  it("still hides tts:text blocks while preserving free-text tts bodies", () => {
    expect(
      cleanDeferredFinalText("A [[tts:text]]whisper[[/tts:text]] [[tts:answered aloud]] Z"),
    ).toBe("A  answered aloud Z");
  });

  it("keeps a lone [[tts:text]] marker out of the deferred visible caption", () => {
    expect(cleanDeferredFinalText("[[tts:text]]")).toBe("");
    expect(cleanDeferredFinalText("say hi [[tts:text]] and beyond")).toBe("say hi ");
  });

  it("preserves a multiline free-text [[tts:...]] body in the deferred caption", () => {
    expect(cleanDeferredFinalText("Before. [[tts:first line\nsecond line]] after")).toBe(
      "Before. first line\nsecond line after",
    );
  });

  it("trims a leading newline after [[tts:]] in the deferred caption", () => {
    expect(cleanDeferredFinalText("Go [[tts:\nhello]] now")).toBe("Go hello now");
  });
});
