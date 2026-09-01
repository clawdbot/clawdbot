import { describe, expect, it } from "vitest";
import { mergeRealtimePartialTranscript } from "./realtime-transcript.js";

describe("mergeRealtimePartialTranscript", () => {
  it("returns previous transcript when the next chunk is blank", () => {
    expect(mergeRealtimePartialTranscript("hello", "   ")).toBe("hello");
  });

  it("replaces with the growing chunk when it extends the previous prefix", () => {
    expect(mergeRealtimePartialTranscript("hel", "hello world")).toBe("hello world");
  });

  it("appends when the next chunk is not a continuation of previous", () => {
    expect(mergeRealtimePartialTranscript("hello", " there")).toBe("hello there");
  });

  it("does not split a surrogate pair at the tail cap boundary", () => {
    const tail = "x".repeat(239);
    const next = `${"y".repeat(50)}🦞${tail}`;

    expect(mergeRealtimePartialTranscript("", next)).toBe(tail);
  });

  it("keeps an intact surrogate pair that sits just inside the cap", () => {
    const tail = `🦞${"w".repeat(238)}`;
    const next = `${"z".repeat(10)}${tail}`;

    expect(mergeRealtimePartialTranscript("", next)).toBe(tail);
  });
});
