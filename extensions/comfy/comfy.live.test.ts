import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { getComfyConfig, isComfyCapabilityConfigured } from "./workflow-runtime.js";

const LIVE =
  isLiveTestEnabled(["COMFY_LIVE_TEST"]) && (process.env.COMFY_LIVE_TEST ?? "").trim() === "1";
const describeLive = LIVE ? describe : describe.skip;

type RegisteredMusicProvider = {
  id: string;
  generateMusic: Function;
  isConfigured?: Function;
};

function withPluginsEnabled<T>(cfg: T): T {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  const record = cfg as Record<string, unknown>;
  return {
    ...record,
    plugins: {
      ...(record.plugins && typeof record.plugins === "object" ? record.plugins : {}),
      enabled: true,
    },
  } as T;
}

function requireProvider<T extends { id: string }>(providers: T[], id: string): T {
  const provider = providers.find((entry) => entry.id === id);
  if (!provider) {
    throw new Error(`expected ${id} provider to be registered`);
  }
  return provider;
}

describeLive("comfy live", () => {
  let cfg = {} as OpenClawConfig;
  let agentDir = "";
  const imageProviders: Array<{ id: string; generateImage: Function; isConfigured?: Function }> =
    [];
  const musicProviders: RegisteredMusicProvider[] = [];
  const videoProviders: Array<{ id: string; generateVideo: Function; isConfigured?: Function }> =
    [];

  beforeAll(async () => {
    cfg = withPluginsEnabled(getRuntimeConfig());
    agentDir = resolveDefaultAgentDir(cfg as never);
    plugin.register(
      createTestPluginApi({
        config: cfg as never,
        registerImageGenerationProvider(provider) {
          imageProviders.push(provider as never);
        },
        registerMusicGenerationProvider(provider) {
          musicProviders.push(provider as never);
        },
        registerVideoGenerationProvider(provider) {
          videoProviders.push(provider as never);
        },
      }),
    );
  });

  it.skipIf(!isComfyCapabilityConfigured({ cfg: cfg as never, agentDir, capability: "image" }))(
    "runs an image workflow",
    async () => {
      const provider = requireProvider(imageProviders, "comfy");
      const result = await provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "A tiny orange lobster icon on a clean background.",
        cfg: cfg as never,
        agentDir,
      });
      expect(result.images.length).toBeGreaterThan(0);
      expect(result.images[0]?.mimeType.startsWith("image/")).toBe(true);
      expect(result.images[0]?.buffer.byteLength).toBeGreaterThan(128);
    },
    120_000,
  );

  it.skipIf(!isComfyCapabilityConfigured({ cfg: cfg as never, agentDir, capability: "video" }))(
    "runs a video workflow",
    async () => {
      const provider = requireProvider(videoProviders, "comfy");
      const result = await provider.generateVideo({
        provider: "comfy",
        model: "workflow",
        prompt: "A tiny paper lobster gently waving, cinematic motion.",
        cfg: cfg as never,
        agentDir,
      });
      expect(result.videos.length).toBeGreaterThan(0);
      expect(result.videos[0]?.mimeType.startsWith("video/")).toBe(true);
      expect(result.videos[0]?.buffer.byteLength).toBeGreaterThan(512);
    },
    180_000,
  );

  it.skipIf(!isComfyCapabilityConfigured({ cfg: cfg as never, agentDir, capability: "music" }))(
    "runs a music workflow",
    async () => {
      const provider = requireProvider(musicProviders, "comfy");
      const result = await provider.generateMusic({
        provider: "comfy",
        model: "workflow",
        prompt: "A gentle ambient synth loop with warm analog pads.",
        cfg: cfg as never,
        agentDir,
      });
      expect(result.tracks.length).toBeGreaterThan(0);
      expect(result.tracks[0]?.mimeType.startsWith("audio/")).toBe(true);
      expect(result.tracks[0]?.buffer.byteLength).toBeGreaterThan(512);
    },
    180_000,
  );

  it("documents the effective comfy config shape for live debugging", () => {
    const comfyConfig = getComfyConfig(cfg as never);
    expect(typeof comfyConfig).toBe("object");
  });
});
