import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { listMicrosoftVoices } from "./speech-provider.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;

describeLive("microsoft plugin live", () => {
  it("lists Edge speech voices", async () => {
    const voices = await listMicrosoftVoices();

    expect(voices.length).toBeGreaterThan(100);
    expect(voices.some((voice) => voice.id === "en-US-MichelleNeural")).toBe(true);
  }, 60_000);
});
