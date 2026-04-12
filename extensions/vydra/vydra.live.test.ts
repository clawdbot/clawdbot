import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const LIVE = isLiveTestEnabled();
const VYDRA_API_KEY = process.env.VYDRA_API_KEY?.trim() ?? "";
const ENABLE_VYDRA_VIDEO_LIVE = process.env.OPENCLAW_LIVE_VYDRA_VIDEO === "1";
const LIVE_IMAGE_MODEL = process.env.OPENCLAW_LIVE_VYDRA_IMAGE_MODEL?.trim() || "grok-imagine";
const LIVE_VIDEO_MODEL = process.env.OPENCLAW_LIVE_VYDRA_VIDEO_MODEL?.trim() || "veo3";
const DEFAULT_LIVE_KLING_IMAGE_URL =
  "https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/showcase/roof-camera-sky.jpg";
const LIVE_KLING_IMAGE_URL =
  process.env.OPENCLAW_LIVE_VYDRA_KLING_IMAGE_URL?.trim() || DEFAULT_LIVE_KLING_IMAGE_URL;
const VYDRA_KLING_TIMEOUT_MS = 12 * 60_000;

const registerVydraPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "vydra",
    name: "Vydra Provider",
  });

function expectBufferedAsset(
  asset: { buffer?: Buffer; mimeType: string } | undefined,
  kind: "image" | "video",
  minBytes: number,
): void {
  expect(asset).toBeDefined();
  expect(asset?.mimeType.startsWith(`${kind}/`)).toBe(true);
  if (!asset?.buffer) {
    throw new Error(`expected generated ${kind} buffer`);
  }
  expect(asset.buffer.byteLength).toBeGreaterThan(minBytes);
}

describe.skipIf(!LIVE || !VYDRA_API_KEY)("vydra live", () => {
  it("generates an image through the registered provider", async () => {
    const { imageProviders } = await registerVydraPlugin();
    const provider = requireRegisteredProvider(imageProviders, "vydra");

    const result = await provider.generateImage({
      provider: "vydra",
      model: LIVE_IMAGE_MODEL,
      prompt: "Create a minimal flat orange square centered on a white background.",
      cfg: { plugins: { enabled: true } } as never,
      agentDir: "/tmp/openclaw-live-vydra-image",
    });

    expect(result.images.length).toBeGreaterThan(0);
    expectBufferedAsset(result.images[0], "image", 512);
  }, 60_000);

  it("synthesizes speech through the registered provider", async () => {
    const { speechProviders } = await registerVydraPlugin();
    const provider = requireRegisteredProvider(speechProviders, "vydra");
    const voices = await provider.listVoices?.({});
    expect(voices).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "21m00Tcm4TlvDq8ikWAM" })]),
    );

    const result = await provider.synthesize({
      text: "OpenClaw integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: VYDRA_API_KEY },
      target: "audio-file",
      timeoutMs: 45_000,
    });

    expect(result.outputFormat).toBe("mp3");
    expect(result.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 60_000);

  it.skipIf(!ENABLE_VYDRA_VIDEO_LIVE)(
    "generates a short video through the registered provider",
    async () => {
      const { videoProviders } = await registerVydraPlugin();
      const provider = requireRegisteredProvider(videoProviders, "vydra");

      const result = await provider.generateVideo({
        provider: "vydra",
        model: LIVE_VIDEO_MODEL,
        prompt:
          "A tiny paper diorama city at sunrise with slow cinematic camera motion and no text.",
        cfg: { plugins: { enabled: true } } as never,
        agentDir: "/tmp/openclaw-live-vydra-video",
      });

      expect(result.videos.length).toBeGreaterThan(0);
      expectBufferedAsset(result.videos[0], "video", 1024);
    },
    8 * 60_000,
  );

  it.skipIf(!ENABLE_VYDRA_VIDEO_LIVE)(
    "generates a kling image-to-video clip from a remote image url",
    async () => {
      const { videoProviders } = await registerVydraPlugin();
      const provider = requireRegisteredProvider(videoProviders, "vydra");

      const result = await provider.generateVideo({
        provider: "vydra",
        model: "kling",
        prompt: "Animate the scene with subtle camera drift and soft cloud motion.",
        cfg: { plugins: { enabled: true } } as never,
        agentDir: "/tmp/openclaw-live-vydra-kling",
        inputImages: [{ url: LIVE_KLING_IMAGE_URL }],
        timeoutMs: VYDRA_KLING_TIMEOUT_MS,
      });

      expect(result.videos.length).toBeGreaterThan(0);
      expectBufferedAsset(result.videos[0], "video", 1024);
    },
    15 * 60_000,
  );
});
