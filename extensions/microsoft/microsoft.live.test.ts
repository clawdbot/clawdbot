import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { listMicrosoftVoices } from "./speech-provider.js";

const describeLive = isLiveTestEnabled() ? describe : describe.skip;

describeLive("microsoft plugin live", () => {
  it("lists Edge speech voices", async () => {
    const voices = await listMicrosoftVoices();

    expect(voices.length).toBeGreaterThan(100);
    expect(voices.map((voice) => voice.id)).toContain("en-US-MichelleNeural");
  }, 60_000);
});
