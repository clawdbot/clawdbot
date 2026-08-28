// Runway tests cover video generation provider plugin behavior.
import {
  capturePluginRegistration,
  createRuntimeEnv,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { postJsonRequestMock, fetchWithTimeoutMock } = getProviderHttpMocks();

let buildRunwayVideoGenerationProvider: typeof import("./video-generation-provider.js").buildRunwayVideoGenerationProvider;

beforeAll(async () => {
  ({ buildRunwayVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function firstPostJsonRequest() {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error("expected Runway create request");
  }
  const [request] = call;
  if (!request || typeof request !== "object") {
    throw new Error("expected Runway create request options");
  }
  return request as { url?: string; body?: Record<string, unknown> };
}

function firstFetchWithTimeoutCall() {
  const [call] = fetchWithTimeoutMock.mock.calls;
  if (!call) {
    throw new Error("expected Runway poll request");
  }
  const [url, init, timeoutMs, requestFetch] = call;
  if (typeof url !== "string") {
    throw new Error("expected Runway poll request URL");
  }
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error("expected Runway poll request init");
  }
  if (typeof timeoutMs !== "number") {
    throw new Error("expected Runway poll request timeout");
  }
  return {
    init: init as { method?: string; headers?: unknown },
    requestFetch,
    timeoutMs,
    url,
  };
}

function streamedVideoResponse(bytes: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    { headers: { "content-type": "video/mp4" } },
  );
}

// Response.json keeps object fixtures on the standard Response body path so create/poll
// reads exercise the byte-bounded reader instead of an unbounded res.json().
function streamedJsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

function streamedRawResponse(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("runway video generation provider", () => {
  it("registers media-only API-key onboarding alongside video generation", async () => {
    const { default: plugin } = await import("./index.js");
    const captured = capturePluginRegistration(plugin);

    expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual(["runway"]);
    expect(captured.modelCatalogProviders).toEqual([]);
    expect(captured.providers).toHaveLength(1);
    expect(captured.providers[0]).toMatchObject({
      id: "runway",
      docsPath: "/providers/runway",
      envVars: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"],
    });

    const choice = resolveProviderPluginChoice({
      providers: captured.providers,
      choice: "runway-api-key",
    });
    expect(choice?.method.id).toBe("api-key");
    expect(choice?.method.starterModel).toBeUndefined();
    expect(choice?.wizard?.onboardingScopes).toEqual(["image-generation"]);
    if (!choice?.method.validateNonInteractive) {
      throw new Error("expected Runway non-interactive API-key validation");
    }

    const resolveApiKey = vi.fn(async () => ({ key: "runway-test-key", source: "flag" as const }));
    expect(
      await choice.method.validateNonInteractive({
        authChoice: "runway-api-key",
        config: {},
        baseConfig: {},
        opts: { runwayApiKey: "runway-test-key" },
        runtime: createRuntimeEnv(),
        resolveApiKey,
      }),
    ).toBe(true);
    expect(resolveApiKey).toHaveBeenCalledWith({
      provider: "runway",
      flagValue: "runway-test-key",
      flagName: "--runway-api-key",
      envVar: "RUNWAYML_API_SECRET",
    });
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildRunwayVideoGenerationProvider());
  });

  it("submits a text-to-video task, polls it, and downloads the output", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({
        id: "task-1",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task-1",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
      )
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/webm" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a tiny lobster DJ under neon lights",
      cfg: {},
      durationSeconds: 4,
      aspectRatio: "16:9",
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const createRequest = firstPostJsonRequest();
    expect(createRequest.url).toBe("https://api.dev.runwayml.com/v1/text_to_video");
    expect(createRequest.body).toEqual({
      model: "gen4.5",
      promptText: "a tiny lobster DJ under neon lights",
      ratio: "1280:720",
      duration: 4,
    });
    const pollCall = firstFetchWithTimeoutCall();
    expect(pollCall.url).toBe("https://api.dev.runwayml.com/v1/tasks/task-1");
    expect(pollCall.init.method).toBe("GET");
    expect(pollCall.init.headers).toBeInstanceOf(Headers);
    expect(pollCall.timeoutMs).toBe(120000);
    expect(pollCall.requestFetch).toBe(fetch);
    expect(result.videos).toHaveLength(1);
    const video = result.videos[0];
    if (!video) {
      throw new Error("expected Runway generated video");
    }
    expect(video.fileName).toBe("video-1.webm");
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.taskId).toBe("task-1");
    expect(metadata.status).toBe("SUCCEEDED");
    expect(metadata.endpoint).toBe("/v1/text_to_video");
  });

  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "problem JSON", contentType: "application/problem+json", body: '{"title":"denied"}' },
    { name: "HTML", contentType: "text/html; charset=utf-8", body: "<html>sign in</html>" },
    { name: "empty video", contentType: "video/mp4", body: "" },
  ])("rejects a successful $name response as generated video", async ({ contentType, body }) => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-invalid-download" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task-invalid-download",
          status: "SUCCEEDED",
          output: ["https://example.com/invalid.mp4"],
        }),
      )
      .mockResolvedValueOnce(new Response(body, { headers: { "content-type": contentType } }));

    await expect(
      buildRunwayVideoGenerationProvider().generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "invalid download",
        cfg: {},
      }),
    ).rejects.toThrow("Runway generated video download: malformed video response");
  });

  it("cancels the unread response body when a generated-video MIME type is rejected", async () => {
    const canceled = vi.fn();
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-open-response" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task-open-response",
          status: "SUCCEEDED",
          output: ["https://example.com/invalid.mp4"],
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"error":"still streaming"}'));
            },
            cancel: canceled,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );

    await expect(
      buildRunwayVideoGenerationProvider().generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "open invalid response",
        cfg: {},
      }),
    ).rejects.toThrow("Runway generated video download: malformed video response");
    expect(canceled).toHaveBeenCalledOnce();
  });

  it("releases a rejected download body without awaiting a debug-capture tee branch", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-captured-response" }),
      release: vi.fn(async () => {}),
    });
    // The debug proxy clones every captured response, so the caller-facing body is one
    // branch of a live tee. Cancelling such a branch settles only once both branches
    // cancel, so awaiting it here would hang the download instead of surfacing the error.
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"still streaming"}'));
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const captureClone = response.clone();
    const captureReader = captureClone.body?.getReader();
    await captureReader?.read();
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task-captured-response",
          status: "SUCCEEDED",
          output: ["https://example.com/invalid.mp4"],
        }),
      )
      .mockResolvedValueOnce(response);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          buildRunwayVideoGenerationProvider().generateVideo({
            provider: "runway",
            model: "gen4.5",
            prompt: "captured invalid response",
            cfg: {},
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              reject(new Error("Runway download waited for a captured response clone"));
            }, 500);
          }),
        ]),
      ).rejects.toThrow("Runway generated video download: malformed video response");
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      await captureReader?.cancel().catch(() => undefined);
    }
  });

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-too-large" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task-too-large",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
      )
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildRunwayVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("Runway generated video download exceeds 1 bytes");
  });

  it("does not round malformed duration values into create requests", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-duration" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task-duration",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
      )
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    await provider.generateVideo({
      provider: "runway",
      model: "gen4.5",
      prompt: "a tiny lobster DJ under neon lights",
      cfg: {},
      durationSeconds: 4.5,
      aspectRatio: "16:9",
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    expect(firstPostJsonRequest().body?.duration).toBe(5);
  });

  it("accepts local image buffers by converting them into data URIs", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-2" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "task-2",
          status: "SUCCEEDED",
          output: ["https://example.com/out.mp4"],
        }),
      )
      .mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
        headers: new Headers({ "content-type": "video/mp4" }),
      });

    const provider = buildRunwayVideoGenerationProvider();
    await provider.generateVideo({
      provider: "runway",
      model: "gen4_turbo",
      prompt: "animate this frame",
      cfg: {},
      inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      aspectRatio: "1:1",
      durationSeconds: 6,
    });

    expect(postJsonRequestMock).toHaveBeenCalledTimes(1);
    const request = firstPostJsonRequest();
    expect(request.url).toBe("https://api.dev.runwayml.com/v1/image_to_video");
    expect(request.body?.promptImage).toMatch(/^data:image\/png;base64,/u);
    expect(request.body?.ratio).toBe("960:960");
    expect(request.body?.duration).toBe(6);
  });

  it("requires gen4_aleph for video-to-video", async () => {
    const provider = buildRunwayVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "restyle this clip",
        cfg: {},
        inputVideos: [{ url: "https://example.com/input.mp4" }],
      }),
    ).rejects.toThrow("Runway video-to-video currently requires model gen4_aleph.");
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("reports malformed create JSON with a provider-owned error", async () => {
    const release = vi.fn(async () => {});
    postJsonRequestMock.mockResolvedValue({
      response: streamedRawResponse("{ not json"),
      release,
    });

    const provider = buildRunwayVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "bad create response",
        cfg: {},
      }),
    ).rejects.toThrow("Runway video generation failed: malformed JSON response");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects status responses missing a task status", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-missing-status" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task-missing-status",
        output: ["https://example.com/out.mp4"],
      }),
    );

    const provider = buildRunwayVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "missing status",
        cfg: {},
      }),
    ).rejects.toThrow("Runway video status response missing task status");
  });

  it("rejects malformed completed output URLs", async () => {
    postJsonRequestMock.mockResolvedValue({
      response: streamedJsonResponse({ id: "task-malformed-output" }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      streamedJsonResponse({
        id: "task-malformed-output",
        status: "SUCCEEDED",
        output: "https://example.com/out.mp4",
      }),
    );

    const provider = buildRunwayVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "runway",
        model: "gen4.5",
        prompt: "malformed output",
        cfg: {},
      }),
    ).rejects.toThrow("Runway video generation completed with malformed output URLs");
  });
});
