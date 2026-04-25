import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const LIVE = isLiveTestEnabled();
const GRADIUM_API_KEY = process.env.GRADIUM_API_KEY?.trim() ?? "";

const registerGradiumPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "gradium",
    name: "Gradium Speech",
  });

describe.skipIf(!LIVE || !GRADIUM_API_KEY)("gradium live", () => {
  it("synthesizes speech through the registered provider", async () => {
    const { speechProviders } = await registerGradiumPlugin();
    const provider = requireRegisteredProvider(speechProviders, "gradium");

    const result = await provider.synthesize({
      text: "Hello, this is a test of Gradium text to speech.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: GRADIUM_API_KEY },
      target: "audio-file",
      timeoutMs: 45_000,
    });

    expect(result.outputFormat).toBe("wav");
    expect(result.audioBuffer.byteLength).toBeGreaterThan(512);

    const outPath = join(tmpdir(), "gradium-live-test.wav");
    writeFileSync(outPath, result.audioBuffer);
    console.log(`Audio written to ${outPath}`);
  }, 60_000);
});
