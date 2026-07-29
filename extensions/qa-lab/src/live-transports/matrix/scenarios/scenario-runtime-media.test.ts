import { describe, expect, it } from "vitest";
import { testing } from "./scenario-runtime-media.js";

describe("Matrix voice preflight reply matching", () => {
  it("accepts punctuation differences in the transcribed marker", () => {
    expect(
      testing.hasMatrixQaVoicePreflightReply(
        '📝 "C3PLQA reply with only these words Matrix QA voice pre-flight OK."',
      ),
    ).toBe(true);
  });
});
