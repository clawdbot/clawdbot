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

  it.each([
    "I'll be right back",
    "goodbye for now",
    "I'll be right back. See you guys. Bye-bye.",
    "Bye.",
    "See you later.",
    "Thanks, bye.",
    "Okay, see you later.",
    "Goodbye, everyone.",
    "Bye, thanks.",
    "Thanks and goodbye.",
    "Bye and thanks.",
    "All right, thanks and goodbye.",
    "Well, goodbye.",
    "See you tomorrow",
    "Bye for now, everyone",
    "Goodbye, take care",
    "Alright, bye.",
    "Thanks a lot, goodbye.",
    "Thank you very much and goodbye.",
    "Have a good day. Goodbye.",
    "Okay, goodbye and have a nice weekend.",
    "Bye for now, folks.",
    "See you tonight.",
    "See you next week.",
    "See you next time.",
    "See you on Monday.",
    "I'll be right back in a minute.",
    "I will be back in a few minutes.",
    "I’ll be right back. Bye.",
    "Good bye.",
    "Good-bye.",
  ])("skips complete closing: %s", (text) => {
    expect(classifySkippableRealtimeVoiceConsultTranscript(text)).toBe("non-actionable-closing");
  });

  it.each([
    "Write a goodbye email to Sam",
    "Translate goodbye into French.",
    "I'll be right back, please check the build.",
    'Explain the code `print("goodbye")`.',
    "can you say goodbye?",
    "what changed in CI?",
    "Okay, write a goodbye email.",
    "Goodbye, everyone, please check the build.",
    "Thanks for checking the build.",
    "Thanks and write a goodbye email.",
    "Well, goodbye everyone, please check the build.",
    "See you tomorrow, and please check the build.",
    "Bye for now, everyone, create a reminder.",
    "Thanks, goodbye. Send me the report.",
    "Have a good day. Write a goodbye email.",
    'Translate "goodbye" into French.',
    'Say "see you later" in Spanish.',
    "Thank you.",
  ])("keeps actionable transcript: %s", (text) => {
    expect(classifySkippableRealtimeVoiceConsultTranscript(text)).toBeUndefined();
  });
});
