import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComfyImageGenerationProvider } from "./image-generation-provider.js";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import {
  buildComfyConfig,
  mockComfyCloudJobResponses,
  mockComfyProviderApiKey,
} from "./test-helpers.js";
import { buildComfyVideoGenerationProvider } from "./video-generation-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const workflow = {
  "6": { inputs: { text: "" } },
  "9": { inputs: {} },
};

const capabilities = [
  {
    capability: "image",
    contentType: "image/png",
    filename: "generated.png",
    outputKind: "images",
    generate: (cfg: OpenClawConfig) =>
      buildComfyImageGenerationProvider().generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "generate an image",
        cfg,
      }),
  },
  {
    capability: "music",
    contentType: "audio/mpeg",
    filename: "generated.mp3",
    outputKind: "audio",
    generate: (cfg: OpenClawConfig) =>
      buildComfyMusicGenerationProvider().generateMusic({
        provider: "comfy",
        model: "workflow",
        prompt: "generate music",
        cfg,
      }),
  },
  {
    capability: "video",
    contentType: "video/mp4",
    filename: "generated.mp4",
    outputKind: "gifs",
    generate: (cfg: OpenClawConfig) =>
      buildComfyVideoGenerationProvider().generateVideo({
        provider: "comfy",
        model: "workflow",
        prompt: "generate a video",
        cfg,
      }),
  },
] as const;

function cloudConfig(apiKey?: unknown): OpenClawConfig {
  return buildComfyConfig({
    mode: "cloud",
    ...(apiKey === undefined ? {} : { apiKey }),
    workflow,
    promptNodeId: "6",
    outputNodeId: "9",
  });
}

function mockResponse(body: unknown, contentType = "application/json") {
  return {
    response: new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": contentType },
    }),
    release: vi.fn(async () => {}),
  };
}

afterEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Comfy provider-owned cloud credentials", () => {
  it.each(capabilities)("sends the snapshot API key for $capability generation", async (entry) => {
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("generated-media"),
      contentType: entry.contentType,
      filename: entry.filename,
      outputKind: entry.outputKind,
      promptId: `cloud-${entry.capability}`,
    });

    await entry.generate(cloudConfig("snapshot-materialized-key"));

    for (const [request] of fetchWithSsrFGuardMock.mock.calls) {
      expect(new Headers(request.init?.headers).get("x-api-key")).toBe("snapshot-materialized-key");
    }
  });

  it.each(capabilities)("blocks cold $capability workflows before cloud egress", async (entry) => {
    vi.stubEnv("COMFY_API_KEY", "ambient-key-must-not-be-used");
    const fallback = mockComfyProviderApiKey("fallback-key-must-not-be-used");

    await expect(
      entry.generate(cloudConfig({ source: "env", provider: "default", id: "COMFY_MISSING_KEY" })),
    ).rejects.toThrow("Comfy Cloud API key missing");

    expect(fallback).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it.each(["env", "file", "exec", "store"])(
    "never falls back for an unmaterialized %s SecretRef",
    async (source) => {
      vi.stubEnv("COMFY_API_KEY", "ambient-key-must-not-be-used");
      vi.stubEnv("COMFY_CLOUD_API_KEY", "ambient-cloud-key-must-not-be-used");
      const fallback = mockComfyProviderApiKey("profile-key-must-not-be-used");
      const id = source === "file" ? "/comfy/apiKey" : "COMFY_MISSING_KEY";

      await expect(
        buildComfyImageGenerationProvider().generateImage({
          provider: "comfy",
          model: "workflow",
          prompt: "generate an image",
          cfg: cloudConfig({ source, provider: "default", id }),
        }),
      ).rejects.toThrow("Comfy Cloud API key missing");

      expect(fallback).not.toHaveBeenCalled();
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it("keeps a local workflow usable while the Comfy cloud owner is cold", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(mockResponse({ prompt_id: "local-job" }))
      .mockResolvedValueOnce(
        mockResponse({
          "local-job": {
            outputs: {
              "9": { images: [{ filename: "generated.png", subfolder: "", type: "output" }] },
            },
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse("image-bytes", "image/png"));

    const result = await buildComfyImageGenerationProvider().generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "generate locally",
      cfg: buildComfyConfig({
        apiKey: { source: "env", provider: "default", id: "COMFY_MISSING_KEY" },
        workflow,
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    expect(result.images).toHaveLength(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });
});
