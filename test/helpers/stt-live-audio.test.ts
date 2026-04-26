import { describe, expect, it } from "vitest";
import { normalizeTranscriptForMatch } from "./stt-live-audio.js";

describe("normalizeTranscriptForMatch", () => {
  it("normalizes punctuation and common OpenClaw live transcription variants", () => {
    expect(normalizeTranscriptForMatch("Open-Claw integration OK")).toBe("openclawintegrationok");
    expect(normalizeTranscriptForMatch("Testing OpenFlaw realtime transcription")).toMatch(
      /open(?:claw|flaw)/,
    );
  });
});
