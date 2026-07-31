// Microsoft tests cover microsoft plugin behavior.
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;

describeLive("microsoft plugin live", () => {
  it("lists Edge speech voices", async () => {
    const listVoices = buildMicrosoftSpeechProvider().listVoices;
    if (!listVoices) {
      throw new Error("expected Microsoft voice listing support");
    }
    const voices = await listVoices({ providerConfig: {} });

    expect(voices.length).toBeGreaterThan(100);
    expect(voices.map((voice) => voice.id)).toContain("en-US-MichelleNeural");
  }, 60_000);
});
