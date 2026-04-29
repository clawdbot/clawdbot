import {
  expectOpenClawLiveTranscriptMarker,
  normalizeTranscriptForMatch,
  OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE,
} from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";

describe("normalizeTranscriptForMatch", () => {
  it("normalizes punctuation and common OpenClaw live transcription variants", () => {
    expect(normalizeTranscriptForMatch("Open-Claw integration OK")).toBe("openclawintegrationok");
    expect(normalizeTranscriptForMatch("Testing OpenFlaw realtime transcription")).toMatch(
      /open(?:claw|flaw)/,
    );
    expect(normalizeTranscriptForMatch("OpenCore xAI realtime transcription")).toMatch(
      OPENCLAW_LIVE_TRANSCRIPT_MARKER_RE,
    );
    expectOpenClawLiveTranscriptMarker("OpenClar integration OK");
  });
});
