// Gandr plugin tests cover the stock voice catalog.
import { describe, expect, it } from "vitest";
import { GANDR_TTS_VOICE_IDS, listGandrVoices } from "./tts.js";

describe("listGandrVoices", () => {
  it("returns the stock voice catalog without a network request", () => {
    const voices = listGandrVoices();
    expect(voices.map((voice) => voice.id)).toEqual([...GANDR_TTS_VOICE_IDS]);
    expect(voices[0]).toEqual({ id: "gandr-mia", name: "Mia" });
  });
});
