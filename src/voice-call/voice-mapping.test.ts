import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLLY_VOICE,
  getOpenAiVoiceNames,
  isOpenAiVoice,
  mapVoiceToPolly,
} from "./voice-mapping.js";

describe("mapVoiceToPolly", () => {
  it("returns default for undefined voice", () => {
    expect(mapVoiceToPolly(undefined)).toBe(DEFAULT_POLLY_VOICE);
  });

  it("passes through Polly voices unchanged", () => {
    expect(mapVoiceToPolly("Polly.Joanna")).toBe("Polly.Joanna");
    expect(mapVoiceToPolly("Polly.Matthew")).toBe("Polly.Matthew");
    expect(mapVoiceToPolly("Polly.Amy")).toBe("Polly.Amy");
  });

  it("passes through Google voices unchanged", () => {
    expect(mapVoiceToPolly("Google.en-US-Standard-A")).toBe(
      "Google.en-US-Standard-A",
    );
    expect(mapVoiceToPolly("Google.en-GB-Wavenet-B")).toBe(
      "Google.en-GB-Wavenet-B",
    );
  });

  it("maps OpenAI voices to Polly equivalents", () => {
    expect(mapVoiceToPolly("alloy")).toBe("Polly.Joanna");
    expect(mapVoiceToPolly("echo")).toBe("Polly.Matthew");
    expect(mapVoiceToPolly("fable")).toBe("Polly.Amy");
    expect(mapVoiceToPolly("onyx")).toBe("Polly.Brian");
    expect(mapVoiceToPolly("nova")).toBe("Polly.Salli");
    expect(mapVoiceToPolly("shimmer")).toBe("Polly.Kimberly");
  });

  it("handles case-insensitive OpenAI voice names", () => {
    expect(mapVoiceToPolly("ALLOY")).toBe("Polly.Joanna");
    expect(mapVoiceToPolly("Echo")).toBe("Polly.Matthew");
    expect(mapVoiceToPolly("ONYX")).toBe("Polly.Brian");
  });

  it("returns default for unknown voices", () => {
    expect(mapVoiceToPolly("unknown-voice")).toBe(DEFAULT_POLLY_VOICE);
    expect(mapVoiceToPolly("random")).toBe(DEFAULT_POLLY_VOICE);
  });
});

describe("isOpenAiVoice", () => {
  it("returns true for OpenAI voices", () => {
    expect(isOpenAiVoice("alloy")).toBe(true);
    expect(isOpenAiVoice("echo")).toBe(true);
    expect(isOpenAiVoice("onyx")).toBe(true);
  });

  it("handles case-insensitive matching", () => {
    expect(isOpenAiVoice("ALLOY")).toBe(true);
    expect(isOpenAiVoice("Echo")).toBe(true);
  });

  it("returns false for non-OpenAI voices", () => {
    expect(isOpenAiVoice("Polly.Joanna")).toBe(false);
    expect(isOpenAiVoice("unknown")).toBe(false);
  });
});

describe("getOpenAiVoiceNames", () => {
  it("returns all supported OpenAI voice names", () => {
    const voices = getOpenAiVoiceNames();

    expect(voices).toContain("alloy");
    expect(voices).toContain("echo");
    expect(voices).toContain("fable");
    expect(voices).toContain("onyx");
    expect(voices).toContain("nova");
    expect(voices).toContain("shimmer");
    expect(voices).toHaveLength(6);
  });
});
