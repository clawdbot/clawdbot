// TTS integration tests cover host runtime availability behavior.
import { afterEach, describe, expect, it } from "vitest";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";

describe("tts runtime facade", () => {
  afterEach(() => {
    setActiveDegradedSecretOwners([]);
  });

  it("blocks explicit synthesis but preserves text delivery when TTS is cold", async () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "tts",
        state: "unavailable",
        paths: ["tts.providers.elevenlabs.apiKey"],
        refKeys: ["env:default:MISSING_TTS_KEY"],
        reason: "secret reference was not found",
      },
    ]);
    await import("./tts.js");
    const { maybeApplyTtsToPayload, textToSpeech } = await import("../plugin-sdk/tts-runtime.js");
    const payload = { text: "Keep this text." };

    await expect(textToSpeech({ text: "Speak this.", cfg: {} })).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "capability",
      ownerId: "tts",
    });
    await expect(maybeApplyTtsToPayload({ payload, cfg: {} })).resolves.toBe(payload);
  });
});
