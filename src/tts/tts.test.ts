// TTS integration tests cover text-to-speech command behavior.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("tts runtime facade", () => {
  afterEach(() => {
    setActiveDegradedSecretOwners([]);
  });

  it("routes public TTS helpers through the core speech package", () => {
    const publicFacadeSource = readSource("./tts.ts");
    const runtimeFacadeSource = readSource("../plugin-sdk/tts-runtime.ts");

    expect(publicFacadeSource).toContain('} from "../plugin-sdk/tts-runtime.js";');
    expect(publicFacadeSource).toContain("setSpeechRuntimeAvailabilityGuard");
    expect(runtimeFacadeSource).toContain('from "../../packages/speech-core/runtime-api.js";');
    expect(runtimeFacadeSource).not.toContain('dirName: "speech-core"');
  });

  it("keeps agent prompt TTS settings off the synthesis runtime chain", () => {
    const agentConfigSource = readSource("../agents/system-prompt-config.ts");
    const settingsFacadeSource = readSource("./tts-settings.ts");
    const packageSettingsSource = readSource("../../packages/speech-core/src/tts-settings.ts");

    expect(agentConfigSource).toContain('from "../tts/tts-settings.js";');
    expect(settingsFacadeSource).toContain(
      'from "../../packages/speech-core/src/tts-settings.js";',
    );
    expect(settingsFacadeSource).not.toContain("tts-runtime");
    expect(packageSettingsSource).toContain('from "openclaw/plugin-sdk/speech-settings";');
    expect(packageSettingsSource).not.toContain("plugin-sdk/media-runtime");
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
