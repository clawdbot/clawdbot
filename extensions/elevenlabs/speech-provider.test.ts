import { describe, expect, it } from "vitest";
import { isValidVoiceId } from "./speech-provider.js";

describe("elevenlabs speech provider", () => {
  it("validates ElevenLabs voice ID length and character rules", () => {
    const cases = [
      { value: "pMsXgVXv3BLzUgSXRplE", expected: true },
      { value: "21m00Tcm4TlvDq8ikWAM", expected: true },
      { value: "VoiceAlias1234567890", expected: true },
      { value: "a1b2c3d4e5", expected: true },
      { value: "a".repeat(40), expected: true },
      { value: "", expected: false },
      { value: "abc", expected: false },
      { value: "123456789", expected: false },
      { value: "a".repeat(41), expected: false },
      { value: "a".repeat(100), expected: false },
      { value: "pMsXgVXv3BLz-gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz_gSXRplE", expected: false },
      { value: "pMsXgVXv3BLz gSXRplE", expected: false },
      { value: "../../../etc/passwd", expected: false },
      { value: "voice?param=value", expected: false },
    ] as const;
    for (const testCase of cases) {
      expect(isValidVoiceId(testCase.value), testCase.value).toBe(testCase.expected);
    }
  });
});
