// Openai tests cover video generation provider plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it, vi } from "vitest";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  postMultipartRequestMock,
  fetchWithTimeoutMock,
  fetchWithTimeoutGuardedMock,
  pollProviderOperationJsonMock,
  assertOkOrThrowHttpErrorMock,
  executeProviderOperationWithRetryMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
} = getProviderHttpMocks();

let buildOpenAIVideoGenerationProvider: typeof import("./video-generation-provider.js").buildOpenAIVideoGenerationProvider;

beforeAll(async () => {
  ({ buildOpenAIVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

function postMultipartRequest(index = 0): Record<string, unknown> {
  const request = postMultipartRequestMock.mock.calls[index]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!request) {
    throw new Error(`expected postMultipartRequest call ${index}`);
  }
  return request;
}

function fetchWithTimeoutCall(index: number): [string, RequestInit | undefined, number, unknown] {
  const call = fetchWithTimeoutMock.mock.calls[index] as
    | [string, RequestInit | undefined, number, unknown]
    | undefined;
  if (!call) {
    throw new Error(`expected fetchWithTimeout call ${index}`);
  }
  return call;
}

function fetchWithTimeoutGuardedCall(
  index = 0,
): [string, RequestInit | undefined, number, unknown, Record<string, unknown> | undefined] {
  const call = fetchWithTimeoutGuardedMock.mock.calls[index] as
    | [string, RequestInit | undefined, number, unknown, Record<string, unknown> | undefined]
    | undefined;
  if (!call) {
    throw new Error(`expected fetchWithTimeoutGuarded call ${index}`);
  }
  return call;
}

function pollProviderOperationRequest(index = 0): Record<string, unknown> {
  const request = pollProviderOperationJsonMock.mock.calls[index]?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!request) {
    throw new Error(`expected pollProviderOperationJson call ${index}`);
  }
  return request;
}

function providerHttpConfigRequest(): Record<string, unknown> {
  const [call] = resolveProviderHttpRequestConfigMock.mock.calls;
  if (!call) {
    throw new Error("expected provider HTTP config request");
  }
  const [request] = call;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("expected provider HTTP config request");
  }
  return request as Record<string, unknown>;
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

// Response.json keeps object fixtures on the standard Response body path so the
// create read exercises the byte-bounded reader instead of an unbounded res.json().
function streamedJsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

describe("openai video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildOpenAIVideoGenerationProvider());
  });

  it("does not claim size or duration controls for OpenAI video edits", () => {
    const provider = buildOpenAIVideoGenerationProvider();

    expect(provider.capabilities.videoToVideo).toEqual({
      enabled: true,
      maxVideos: 1,
      maxInputVideos: 1,
    });
  });

  it("advertises OpenAI video for an actual config-only API key", () => {
    expect(
      buildOpenAIVideoGenerationProvider().isConfigured?.({
        cfg: {
          models: {
            providers: {
              openai: {
                apiKey: "openai-video-config-key",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("does not advertise video generation for OAuth-only OpenAI profiles", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-openai-video-auth-"));
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:chatgpt": {
              type: "oauth",
              provider: "openai",
              access: "chatgpt-oauth-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );

      expect(buildOpenAIVideoGenerationProvider().isConfigured?.({ agentDir })).toBe(false);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
      // Saving the profile store opens the per-agent database under the temporary agent
      // dir, and clearing the snapshots does not release it, so Windows fails the removal
      // with EBUSY unless the cached handles are closed first.
      closeOpenClawAgentDatabasesForTest();
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("requires an OpenAI API key credential for direct video generation", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({
      apiKey: "chatgpt-oauth-token",
      mode: "oauth",
    } as never);

    const provider = buildOpenAIVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "A paper airplane gliding through golden hour light",
        cfg: {},
      }),
    ).rejects.toThrow("OpenAI API key missing");

    expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelApi: "openai-responses",
      }),
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("uses SDK-compatible multipart for text-only Sora requests", async () => {
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_123",
        model: "sora-2",
        status: "queued",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_123",
          model: "sora-2",
          status: "completed",
          seconds: "4",
          size: "720x1280",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/webm" }),
        arrayBuffer: async () => Buffer.from("webm-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "A paper airplane gliding through golden hour light",
      cfg: {},
      durationSeconds: 4,
    });

    const createRequest = postMultipartRequest();
    expect(createRequest.url).toBe("https://api.openai.com/v1/videos");
    const form = createRequest.body as FormData;
    expect(form.get("prompt")).toBe("A paper airplane gliding through golden hour light");
    expect(form.get("model")).toBe("sora-2");
    expect(form.get("seconds")).toBe("4");
    expect(form.get("input_reference")).toBeNull();
    const [pollUrl, pollInit, pollTimeout, pollFetch] = fetchWithTimeoutCall(0);
    expect(pollUrl).toBe("https://api.openai.com/v1/videos/vid_123");
    expect(pollInit?.method).toBe("GET");
    expect(pollTimeout).toBe(120000);
    expect(pollFetch).toBe(fetch);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.mimeType).toBe("video/webm");
    expect(result.videos[0]?.fileName).toBe("video-1.webm");
    expect(result.metadata?.videoId).toBe("vid_123");
    expect(result.metadata?.status).toBe("completed");
  });

  it.each(["vid_failed", undefined])(
    "surfaces an immediately failed OpenAI submission before polling or validating id (%s)",
    async (videoId) => {
      const release = vi.fn(async () => {});
      postMultipartRequestMock.mockResolvedValueOnce({
        response: streamedJsonResponse({
          ...(videoId ? { id: videoId } : {}),
          status: "failed",
          error: { message: "OpenAI video generation was rejected" },
        }),
        release,
      });

      await expect(
        buildOpenAIVideoGenerationProvider().generateVideo({
          provider: "openai",
          model: "sora-2",
          prompt: "A scene that cannot be generated",
          cfg: {},
        }),
      ).rejects.toThrow("OpenAI video generation was rejected");

      expect(pollProviderOperationJsonMock).not.toHaveBeenCalled();
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("downloads an immediately completed OpenAI submission without polling it again", async () => {
    const release = vi.fn(async () => {});
    const cancel = vi.fn();
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_completed",
        model: "sora-2",
        status: "completed",
        seconds: "4",
        size: "720x1280",
      }),
      release,
    });
    fetchWithTimeoutMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("completed-video"));
            controller.close();
          },
          cancel,
        }),
        { headers: { "content-type": "video/mp4" } },
      ),
    );

    const result = await buildOpenAIVideoGenerationProvider().generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "A scene already generated",
      cfg: {},
    });

    expect(pollProviderOperationJsonMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model: "sora-2",
      metadata: { seconds: "4", size: "720x1280", status: "completed", videoId: "vid_completed" },
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "JSON error",
      contentType: "application/json",
      body: JSON.stringify({ error: "not a rendered video" }),
    },
    {
      label: "problem JSON error",
      contentType: "application/problem+json",
      body: JSON.stringify({ detail: "render failed" }),
    },
    { label: "plain-text error", contentType: "text/plain", body: "render failed" },
    { label: "HTML error", contentType: "text/html", body: "<html>render failed</html>" },
    { label: "empty video", contentType: "video/mp4", body: "" },
  ])(
    "rejects a successful $label download and releases both requests",
    async ({ contentType, body }) => {
      const submissionRelease = vi.fn(async () => {});
      const downloadRelease = vi.fn(async () => {});
      postMultipartRequestMock.mockResolvedValueOnce({
        response: streamedJsonResponse({
          id: "vid_malformed",
          model: "sora-2",
          status: "completed",
        }),
        release: submissionRelease,
      });
      fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
        response: new Response(body, { headers: { "content-type": contentType } }),
        finalUrl: "http://127.0.0.1:44080/v1/videos/vid_malformed/content?variant=video",
        release: downloadRelease,
      });

      await expect(
        buildOpenAIVideoGenerationProvider().generateVideo({
          provider: "openai",
          model: "sora-2",
          prompt: "Reject an invalid generated video",
          cfg: {
            models: {
              providers: {
                openai: {
                  baseUrl: "http://127.0.0.1:44080/v1",
                  request: { allowPrivateNetwork: true },
                  models: [],
                },
              },
            },
          },
        }),
      ).rejects.toThrow("OpenAI generated video download: malformed video response");

      expect(pollProviderOperationJsonMock).not.toHaveBeenCalled();
      expect(submissionRelease).toHaveBeenCalledOnce();
      expect(downloadRelease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { mode: "public", allowPrivateNetwork: false },
    { mode: "guarded private", allowPrivateNetwork: true },
  ])(
    "cancels unread malformed $mode video responses and closes their upstream socket",
    async ({ allowPrivateNetwork }) => {
      let notifySocketClosed: ((closed: boolean) => void) | undefined;
      const socketClosed = new Promise<boolean>((resolve) => {
        notifySocketClosed = resolve;
      });
      await withServer(
        (request, response) => {
          request.socket.once("close", () => notifySocketClosed?.(true));
          response.writeHead(200, { "content-type": "application/json" });
          response.write('{"error":"still streaming');
        },
        async (baseUrl) => {
          postMultipartRequestMock.mockResolvedValueOnce({
            response: streamedJsonResponse({ id: "vid_unread", status: "completed" }),
            release: vi.fn(async () => {}),
          });
          const upstreamUrl = `${baseUrl}/videos/vid_unread/content`;
          const downloadRelease = vi.fn(async () => {});
          if (allowPrivateNetwork) {
            fetchWithTimeoutGuardedMock.mockImplementationOnce(async () => ({
              response: await fetch(upstreamUrl),
              finalUrl: upstreamUrl,
              release: downloadRelease,
            }));
          } else {
            fetchWithTimeoutMock.mockImplementationOnce(async () => await fetch(upstreamUrl));
          }

          await expect(
            buildOpenAIVideoGenerationProvider().generateVideo({
              provider: "openai",
              model: "sora-2",
              prompt: "Reject an unending public video error response",
              cfg: allowPrivateNetwork
                ? {
                    models: {
                      providers: {
                        openai: {
                          baseUrl: `${baseUrl}/v1`,
                          request: { allowPrivateNetwork: true },
                          models: [],
                        },
                      },
                    },
                  }
                : {},
            }),
          ).rejects.toThrow("OpenAI generated video download: malformed video response");

          await expect(
            Promise.race([
              socketClosed,
              new Promise<boolean>((resolve) => {
                setTimeout(() => resolve(false), 250);
              }),
            ]),
          ).resolves.toBe(true);
          if (allowPrivateNetwork) {
            expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledOnce();
            expect(downloadRelease).toHaveBeenCalledOnce();
          } else {
            expect(fetchWithTimeoutGuardedMock).not.toHaveBeenCalled();
          }
        },
      );
    },
  );

  it.each([
    { mode: "public", allowPrivateNetwork: false },
    { mode: "guarded private", allowPrivateNetwork: true },
  ])(
    "rejects cloned endless $mode video errors without waiting for capture cancellation",
    async ({ allowPrivateNetwork }) => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"still streaming'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      const captureClone = response.clone();
      const submissionRelease = vi.fn(async () => {});
      const downloadRelease = vi.fn(async () => {});
      postMultipartRequestMock.mockResolvedValueOnce({
        response: streamedJsonResponse({ id: "vid_cloned", status: "completed" }),
        release: submissionRelease,
      });
      if (allowPrivateNetwork) {
        fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
          response,
          finalUrl: "http://127.0.0.1:44080/v1/videos/vid_cloned/content",
          release: downloadRelease,
        });
      } else {
        fetchWithTimeoutMock.mockResolvedValueOnce(response);
      }

      const generation = buildOpenAIVideoGenerationProvider().generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "Reject a cloned, unending video error",
        cfg: allowPrivateNetwork
          ? {
              models: {
                providers: {
                  openai: {
                    baseUrl: "http://127.0.0.1:44080/v1",
                    request: { allowPrivateNetwork: true },
                    models: [],
                  },
                },
              },
            }
          : {},
      });
      const captureCancellationPending = Symbol("capture cancellation pending");

      try {
        const result = await Promise.race([
          generation.then(
            () => undefined,
            (error: unknown) => error,
          ),
          new Promise<symbol>((resolve) => {
            setImmediate(() => resolve(captureCancellationPending));
          }),
        ]);

        expect(result).not.toBe(captureCancellationPending);
        expect(result).toMatchObject({
          message: "OpenAI generated video download: malformed video response",
        });
        expect(submissionRelease).toHaveBeenCalledOnce();
        if (allowPrivateNetwork) {
          expect(downloadRelease).toHaveBeenCalledOnce();
        }
      } finally {
        void captureClone.body?.cancel().catch(() => undefined);
        await generation.catch(() => undefined);
      }
    },
  );

  it.each(["application/json", "text/plain"])(
    "keeps the malformed public video error when %s body cancellation fails",
    async (contentType) => {
      const cancel = vi.fn(async () => {
        throw new Error("upstream cancellation failed");
      });
      const submissionRelease = vi.fn(async () => {});
      postMultipartRequestMock.mockResolvedValueOnce({
        response: streamedJsonResponse({ id: "vid_cancel_failed", status: "completed" }),
        release: submissionRelease,
      });
      fetchWithTimeoutMock.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("still streaming"));
            },
            cancel,
          }),
          { headers: { "content-type": contentType } },
        ),
      );

      await expect(
        buildOpenAIVideoGenerationProvider().generateVideo({
          provider: "openai",
          model: "sora-2",
          prompt: "Preserve the malformed public video response error",
          cfg: {},
        }),
      ).rejects.toThrow("OpenAI generated video download: malformed video response");

      expect(cancel).toHaveBeenCalledOnce();
      expect(submissionRelease).toHaveBeenCalledOnce();
      expect(fetchWithTimeoutGuardedMock).not.toHaveBeenCalled();
    },
  );

  it("rejects generated video downloads that exceed the configured media cap", async () => {
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_too_large",
        model: "sora-2",
        status: "queued",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_too_large",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce(streamedVideoResponse("too-large"));

    const provider = buildOpenAIVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "short video",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("OpenAI generated video download exceeds 1 bytes");
  });

  it("uploads the SDK-compatible image reference in a multipart video request", async () => {
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_456",
        model: "sora-2",
        status: "queued",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_456",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    const input = Buffer.from("!png-bytes?").subarray(1, -1);
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Animate this frame",
      cfg: {},
      inputImages: [{ buffer: input, mimeType: "image/png" }],
    });
    input.fill(0);

    const createRequest = postMultipartRequest();
    expect(createRequest.url).toBe("https://api.openai.com/v1/videos");
    const form = createRequest.body as FormData;
    const reference = form.get("input_reference");
    expect(reference).toBeInstanceOf(File);
    const referenceFile = reference as File;
    expect(referenceFile.name).toBe("reference-image.png");
    expect(referenceFile.type).toBe("image/png");
    expect(Buffer.from(await referenceFile.arrayBuffer())).toEqual(Buffer.from("png-bytes"));
    const [pollUrl, pollInit, pollTimeout, pollFetch] = fetchWithTimeoutCall(0);
    expect(pollUrl).toBe("https://api.openai.com/v1/videos/vid_456");
    expect(pollInit?.method).toBe("GET");
    expect(pollTimeout).toBe(120000);
    expect(pollFetch).toBe(fetch);
  });

  it("keeps configured local baseUrl private-network blocked unless explicitly enabled", async () => {
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_local",
        model: "sora-2",
        status: "queued",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Render via local relay",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              models: [],
            },
          },
        },
      },
    });

    expect(providerHttpConfigRequest().baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(providerHttpConfigRequest().request).toBeUndefined();
    const createRequest = postMultipartRequest();
    expect(createRequest.url).toBe("http://127.0.0.1:44080/v1/videos");
    expect(createRequest.allowPrivateNetwork).toBe(false);
  });

  it("honors configured request allowPrivateNetwork for local video providers", async () => {
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_local",
        model: "sora-2",
        status: "queued",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock
      .mockResolvedValueOnce({
        json: async () => ({
          id: "vid_local",
          model: "sora-2",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Render via local relay",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith({
      allowPrivateNetwork: true,
    });
    expect(providerHttpConfigRequest().baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(providerHttpConfigRequest().request).toEqual({ allowPrivateNetwork: true });
    const createRequest = postMultipartRequest();
    expect(createRequest.url).toBe("http://127.0.0.1:44080/v1/videos");
    expect(createRequest.allowPrivateNetwork).toBe(true);
    const statusRequest = pollProviderOperationRequest();
    expect(statusRequest.url).toBe("http://127.0.0.1:44080/v1/videos/vid_local");
    expect(statusRequest.allowPrivateNetwork).toBe(true);
    expect(statusRequest.auditContext).toBe("openai-video-status");
    const [downloadUrl, downloadInit, downloadTimeout, downloadFetch, downloadOptions] =
      fetchWithTimeoutGuardedCall();
    expect(downloadUrl).toBe("http://127.0.0.1:44080/v1/videos/vid_local/content?variant=video");
    expect(downloadInit?.method).toBe("GET");
    // Download shares the generation deadline, so earlier phases consume part of this budget.
    expect(downloadTimeout).toBeGreaterThan(0);
    expect(downloadTimeout).toBeLessThanOrEqual(120_000);
    expect(downloadFetch).toBe(fetch);
    expect(downloadOptions).toEqual({
      ssrfPolicy: { allowPrivateNetwork: true },
      auditContext: "openai-video-download",
    });
  });

  it("retries guarded local video downloads after transient HTTP errors", async () => {
    const firstRelease = vi.fn(async () => {});
    const secondRelease = vi.fn(async () => {});
    assertOkOrThrowHttpErrorMock
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async (_response, label) => {
        throw new Error(label);
      })
      .mockImplementationOnce(async () => {});
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_local",
        model: "sora-2",
        status: "queued",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        id: "vid_local",
        model: "sora-2",
        status: "completed",
      }),
    });
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce({
        response: new Response("busy", { status: 503, statusText: "Service Unavailable" }),
        finalUrl: "http://127.0.0.1:44080/v1/videos/vid_local/content?variant=video",
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        response: {
          headers: new Headers({ "content-type": "video/mp4" }),
          arrayBuffer: async () => Buffer.from("mp4-bytes"),
        },
        finalUrl: "http://127.0.0.1:44080/v1/videos/vid_local/content?variant=video",
        release: secondRelease,
      });

    const provider = buildOpenAIVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Render via local relay",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
    });

    expect(result.videos[0]?.buffer?.toString()).toBe("mp4-bytes");
    expect(executeProviderOperationWithRetryMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", stage: "download" }),
    );
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it("releases guarded local video download requests when HTTP errors throw", async () => {
    const firstRelease = vi.fn(async () => {});
    const secondRelease = vi.fn(async () => {});
    assertOkOrThrowHttpErrorMock
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async (_response, label) => {
        throw new Error(label);
      })
      .mockImplementationOnce(async (_response, label) => {
        throw new Error(label);
      });
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_local",
        model: "sora-2",
        status: "queued",
      }),
      release: vi.fn(async () => {}),
    });
    fetchWithTimeoutMock.mockResolvedValueOnce({
      json: async () => ({
        id: "vid_local",
        model: "sora-2",
        status: "completed",
      }),
    });
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce({
        response: new Response("busy", { status: 503, statusText: "Service Unavailable" }),
        finalUrl: "http://127.0.0.1:44080/v1/videos/vid_local/content?variant=video",
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        response: new Response("busy", { status: 503, statusText: "Service Unavailable" }),
        finalUrl: "http://127.0.0.1:44080/v1/videos/vid_local/content?variant=video",
        release: secondRelease,
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "Render via local relay",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:44080/v1",
                request: { allowPrivateNetwork: true },
                models: [],
              },
            },
          },
        },
      }),
    ).rejects.toThrow("OpenAI video download failed");

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledTimes(1);
    expect(secondRelease).toHaveBeenCalledTimes(1);
  });

  it("uses the video edits endpoint for video-to-video uploads", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "vid_789",
          model: "sora-2",
          status: "queued",
        }),
      )
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "vid_789",
          model: "sora-2",
          status: "completed",
        }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    const input = Buffer.from("!mp4-bytes?").subarray(1, -1);
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Remix this clip",
      cfg: {},
      inputVideos: [{ buffer: input, mimeType: "video/mp4" }],
    });
    input.fill(0);

    expect(postJsonRequestMock).not.toHaveBeenCalled();
    const createRequest = postMultipartRequest();
    expect(createRequest.url).toBe("https://api.openai.com/v1/videos/edits");
    expect(createRequest.body).toBeInstanceOf(FormData);
    const form = createRequest.body as FormData;
    expect(form.get("prompt")).toBe("Remix this clip");
    expect(form.get("model")).toBeNull();
    expect(form.get("video")).toBeInstanceOf(File);
    expect(Buffer.from(await (form.get("video") as File).arrayBuffer())).toEqual(
      Buffer.from("mp4-bytes"),
    );
    expect(form.get("input_reference")).toBeNull();
    expect(createRequest.timeoutMs).toBe(120000);
    expect(createRequest.fetchFn).toBe(fetch);
    expect(createRequest.allowPrivateNetwork).toBe(false);
  });

  it("surfaces an immediately failed OpenAI video edit without polling it", async () => {
    const release = vi.fn(async () => {});
    postMultipartRequestMock.mockResolvedValueOnce({
      response: streamedJsonResponse({
        id: "vid_edit_failed",
        status: "failed",
        error: { message: "OpenAI video edit was rejected" },
      }),
      release,
    });

    await expect(
      buildOpenAIVideoGenerationProvider().generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "Remix this clip",
        cfg: {},
        inputVideos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("OpenAI video edit was rejected");

    expect(pollProviderOperationJsonMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("downloads an immediately completed OpenAI video edit without polling it again", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({ id: "vid_edit_completed", model: "sora-2", status: "completed" }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("completed-edit"),
      });

    const result = await buildOpenAIVideoGenerationProvider().generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Remix this clip",
      cfg: {},
      inputVideos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    });

    expect(pollProviderOperationJsonMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
    expect(result.metadata).toMatchObject({ status: "completed", videoId: "vid_edit_completed" });
  });

  it("honors configured request allowPrivateNetwork for multipart video uploads", async () => {
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "vid_789",
          model: "sora-2",
          status: "queued",
        }),
      )
      .mockResolvedValueOnce(
        streamedJsonResponse({
          id: "vid_789",
          model: "sora-2",
          status: "completed",
        }),
      )
      .mockResolvedValueOnce({
        headers: new Headers({ "content-type": "video/mp4" }),
        arrayBuffer: async () => Buffer.from("mp4-bytes"),
      });

    const provider = buildOpenAIVideoGenerationProvider();
    await provider.generateVideo({
      provider: "openai",
      model: "sora-2",
      prompt: "Remix this clip",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "http://127.0.0.1:44080/v1",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      inputVideos: [{ buffer: Buffer.from("mp4-bytes"), mimeType: "video/mp4" }],
    });

    expect(postJsonRequestMock).not.toHaveBeenCalled();
    const createRequest = postMultipartRequest();
    expect(createRequest.url).toBe("http://127.0.0.1:44080/v1/videos/edits");
    expect(createRequest.body).toBeInstanceOf(FormData);
    expect(createRequest.allowPrivateNetwork).toBe(true);
    expect(pollProviderOperationRequest().allowPrivateNetwork).toBe(true);
    expect(fetchWithTimeoutGuardedCall()[4]).toEqual({
      ssrfPolicy: { allowPrivateNetwork: true },
      auditContext: "openai-video-download",
    });
  });

  it("rejects multiple reference assets", async () => {
    const provider = buildOpenAIVideoGenerationProvider();

    await expect(
      provider.generateVideo({
        provider: "openai",
        model: "sora-2",
        prompt: "Animate these",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("a"), mimeType: "image/png" }],
        inputVideos: [{ buffer: Buffer.from("b"), mimeType: "video/mp4" }],
      }),
    ).rejects.toThrow("OpenAI video generation supports at most one reference image or video.");
  });
});
