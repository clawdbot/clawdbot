// Deepinfra tests cover video generation provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const {
  postJsonRequestMock,
  fetchWithTimeoutMock,
  pollProviderOperationJsonMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

let buildDeepInfraVideoGenerationProvider: typeof import("./video-generation-provider.js").buildDeepInfraVideoGenerationProvider;

beforeAll(async () => {
  ({ buildDeepInfraVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function mockSubmit(job: unknown, release = vi.fn(async () => {})): typeof release {
  postJsonRequestMock.mockResolvedValue({
    response: { json: async () => job },
    release,
  });
  return release;
}

function requireFirstPostJsonRequest(): unknown {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected DeepInfra video submit request");
  }
  return call[0];
}

describe("deepinfra video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildDeepInfraVideoGenerationProvider());
  });

  it("uses the current DeepInfra text-to-video fallback model first", () => {
    const provider = buildDeepInfraVideoGenerationProvider();

    expect(provider.defaultModel).toBe("Pixverse/Pixverse-T2V");
    expect(provider.models?.slice(0, 3)).toEqual([
      "Pixverse/Pixverse-T2V",
      "Pixverse/Pixverse-T2V-HD",
      "Wan-AI/Wan2.6-T2V",
    ]);
  });

  it("submits an OpenAI video job, polls until succeeded, and returns the hosted output URL", async () => {
    const release = mockSubmit({ id: "videos_abc", status: "queued" });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({ id: "videos_abc", status: "processing" }),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        id: "videos_abc",
        status: "succeeded",
        model: "Pixverse/Pixverse-T2V",
        data: [{ url: "/generated/video.mp4" }],
      }),
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {},
      aspectRatio: "16:9",
      durationSeconds: 8,
      providerOptions: {
        seed: 42,
        negative_prompt: "blur",
        style: "anime",
      },
    });

    expect(resolveProviderHttpRequestConfigMock.mock.calls).toEqual([
      [
        {
          baseUrl: "https://api.deepinfra.com/v1/openai",
          defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: "Bearer provider-key",
            "Content-Type": "application/json",
          },
          provider: "deepinfra",
          capability: "video",
          transport: "http",
        },
      ],
    ]);

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = requireFirstPostJsonRequest();
    const postRequestHeaders = Reflect.get(postRequest ?? {}, "headers");
    expect(postRequestHeaders).toBeInstanceOf(Headers);
    expect(Object.fromEntries((postRequestHeaders as Headers).entries())).toEqual({
      authorization: "Bearer provider-key",
      "content-type": "application/json",
    });
    expect(postRequest).toEqual({
      url: "https://api.deepinfra.com/v1/openai/videos",
      headers: postRequestHeaders,
      body: {
        model: "Pixverse/Pixverse-T2V",
        prompt: "A bicycle weaving through a rainy neon street",
        aspect_ratio: "16:9",
        seconds: 8,
        seed: 42,
        negative_prompt: "blur",
        style: "anime",
      },
      timeoutMs: 60_000,
      fetchFn: fetch,
      allowPrivateNetwork: false,
      dispatcherPolicy: undefined,
    });

    expect(pollProviderOperationJsonMock).toHaveBeenCalledOnce();
    const pollUrls = fetchWithTimeoutMock.mock.calls.map((call) => call[0]);
    expect(pollUrls).toEqual([
      "https://api.deepinfra.com/v1/openai/videos/videos_abc",
      "https://api.deepinfra.com/v1/openai/videos/videos_abc",
    ]);

    expect(result.videos).toEqual([
      {
        url: "https://api.deepinfra.com/generated/video.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
    expect(result.model).toBe("Pixverse/Pixverse-T2V");
    expect(result.metadata).toEqual({
      jobId: "videos_abc",
      status: "succeeded",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns immediately without polling when the submit response already succeeded", async () => {
    mockSubmit({
      id: "videos_fast",
      status: "succeeded",
      data: [{ url: "/generated/fast.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "An instant video",
      cfg: {},
    });

    expect(pollProviderOperationJsonMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(result.videos).toEqual([
      {
        url: "https://api.deepinfra.com/generated/fast.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
    expect(result.metadata).toEqual({ jobId: "videos_fast", status: "succeeded" });
  });

  it("resolves relative video URLs against a configured OpenAI-compatible baseUrl", async () => {
    mockSubmit({
      id: "videos_custom",
      status: "succeeded",
      data: [{ url: "/generated/custom.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A video from a custom endpoint",
      cfg: {
        models: {
          providers: {
            deepinfra: { baseUrl: "https://video.example.com/v1/openai" },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(Reflect.get(requireFirstPostJsonRequest() ?? {}, "url")).toBe(
      "https://video.example.com/v1/openai/videos",
    );
    expect(result.videos).toEqual([
      {
        url: "https://video.example.com/generated/custom.mp4",
        mimeType: "video/mp4",
        fileName: "video-1.mp4",
      },
    ]);
  });

  it("ignores legacy nativeBaseUrl config; doctor owns its migration", async () => {
    mockSubmit({
      id: "videos_native",
      status: "succeeded",
      data: [{ url: "/generated/native.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A video from a legacy config",
      cfg: {
        models: {
          providers: {
            deepinfra: { nativeBaseUrl: "https://gw.example.com/v1/inference" },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(resolveProviderHttpRequestConfigMock.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: "https://api.deepinfra.com/v1/openai",
    });
  });

  it("fails closed on a retired /v1/inference baseUrl without sending a request", async () => {
    const provider = buildDeepInfraVideoGenerationProvider();
    const error = await provider
      .generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A video against a retired endpoint",
        cfg: {
          models: {
            providers: {
              deepinfra: {
                // Assembled from pieces so TruffleHog's URI detector
                // (security-fast CI gate) does not flag the fixture.
                baseUrl: ["https://user", "password@gw.example.com/v1/inference?token=secret"].join(
                  ":",
                ),
              },
            },
          },
        } as unknown as OpenClawConfig,
      })
      .then(
        () => undefined,
        (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))),
      );

    expect(error?.message).toMatch(/retired native \/v1\/inference surface/u);
    expect(error?.message).toContain("openclaw doctor --fix");
    // Fail-closed means no submit request and no configured-URL echo (it may
    // carry credentials).
    expect(postJsonRequestMock).not.toHaveBeenCalled();
    expect(error?.message).not.toMatch(/password|secret|gw\.example\.com/u);
  });

  it("does not forward malformed video seed values", async () => {
    mockSubmit({
      id: "videos_seed",
      status: "succeeded",
      data: [{ url: "/generated/video.mp4" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A bicycle weaving through a rainy neon street",
      cfg: {},
      providerOptions: {
        seed: 1.5,
      },
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const postRequest = requireFirstPostJsonRequest();
    expect(Reflect.get(Reflect.get(postRequest ?? {}, "body") ?? {}, "seed")).toBeUndefined();
  });

  it("decodes base64 data URL video outputs from the MIME type", async () => {
    mockSubmit({
      id: "videos_webm",
      status: "succeeded",
      data: [{ url: `data:video/webm;base64,${Buffer.from("webm-data").toString("base64")}` }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "deepinfra",
      model: "deepinfra/Pixverse/Pixverse-T2V",
      prompt: "A WebM data URL",
      cfg: {},
    });

    expect(result.videos).toHaveLength(1);
    const [video] = result.videos;
    if (!video) {
      throw new Error("Expected generated DeepInfra video");
    }
    expect(video).toEqual({
      buffer: Buffer.from("webm-data"),
      mimeType: "video/webm",
      fileName: "video-1.webm",
    });
  });

  it("throws the job error when the video generation fails", async () => {
    mockSubmit({ id: "videos_fail", status: "queued" });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({ id: "videos_fail", status: "failed", error: "model overloaded" }),
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A failing video",
        cfg: {},
      }),
    ).rejects.toThrow("model overloaded");
  });

  it("reports malformed submit JSON as a provider error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: {
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      },
      release,
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A bicycle weaving through a rainy neon street",
        cfg: {},
      }),
    ).rejects.toThrow("DeepInfra video generation failed: malformed JSON response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects malformed base64 data URL video outputs", async () => {
    mockSubmit({
      id: "videos_bad",
      status: "succeeded",
      data: [{ url: "data:video/webm;base64,not-base64!" }],
    });

    const provider = buildDeepInfraVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "deepinfra",
        model: "deepinfra/Pixverse/Pixverse-T2V",
        prompt: "A malformed WebM data URL",
        cfg: {},
      }),
    ).rejects.toThrow("DeepInfra video response returned malformed data URL base64");
  });
});
