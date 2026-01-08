import { describe, expect, it } from "vitest";

import { extractAudioTag } from "./audio-tags.js";

describe("extractAudioTag", () => {
  it("detects audio_as_voice and strips the tag", () => {
    const result = extractAudioTag("Hello [[audio_as_voice]] world");
    expect(result.audioAsVoice).toBe(true);
    expect(result.hasTag).toBe(true);
    expect(result.cleaned).toBe("Hello world");
  });

  it("returns empty output for missing text", () => {
    const result = extractAudioTag(undefined);
    expect(result.audioAsVoice).toBe(false);
    expect(result.hasTag).toBe(false);
    expect(result.cleaned).toBe("");
  });

  it("removes tag-only messages", () => {
    const result = extractAudioTag("[[audio_as_voice]]");
    expect(result.audioAsVoice).toBe(true);
    expect(result.cleaned).toBe("");
  });
});
