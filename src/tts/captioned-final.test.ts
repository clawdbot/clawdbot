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
  it("keeps TTS-only text out of the visible final", () => {
    expect(cleanDeferredFinalText("Visible. [[tts:text]]Private speech.[[/tts:text]] Done.")).toBe(
      "Visible.  Done.",
    );
  });
});
