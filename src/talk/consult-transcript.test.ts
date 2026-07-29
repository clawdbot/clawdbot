// Consult transcript tests cover transcript formatting for talk consults.
import { describe, expect, it } from "vitest";
import { classifySkippableRealtimeVoiceConsultTranscript } from "./consult-transcript.js";

describe("realtime voice consult transcript classification", () => {
  it("skips empty and incomplete transcripts", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("  ")).toBe("empty");
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you check...")).toBe(
      "incomplete-transcript",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you check…")).toBe(
      "incomplete-transcript",
    );
  });

  it("skips likely trailing fragments", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("tell me about")).toBe(
      "trailing-fragment",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("ship it so")).toBe("trailing-fragment");
  });

  it("skips non-actionable closings unless phrased as a question", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("I'll be right back")).toBe(
      "non-actionable-closing",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("goodbye for now")).toBe(
      "non-actionable-closing",
    );
    expect(classifySkippableRealtimeVoiceConsultTranscript("can you say goodbye?")).toBeUndefined();
  });

  it("keeps actionable transcripts", () => {
    expect(classifySkippableRealtimeVoiceConsultTranscript("what changed in CI?")).toBeUndefined();
  });
});
