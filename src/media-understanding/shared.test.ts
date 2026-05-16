import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";

const { fetchWithSsrFGuardMock, shouldUseEnvHttpProxyForUrlMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  shouldUseEnvHttpProxyForUrlMock: vi.fn(() => false),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

vi.mock("../infra/net/proxy-env.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/proxy-env.js")>(
    "../infra/net/proxy-env.js",
  );
  return {
    ...actual,
    shouldUseEnvHttpProxyForUrl: shouldUseEnvHttpProxyForUrlMock,
  };
});

import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchProviderDownloadResponse,
  fetchWithTimeoutGuarded,
  pollProviderOperationJson,
  postJsonRequest,
  postTranscriptionRequest,
  readErrorResponse,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
} from "./shared.js";

beforeEach(() => {
  shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function getFirstGuardedFetchCall() {
  const [mockCall] = fetchWithSsrFGuardMock.mock.calls;
  if (!mockCall) {
    throw new Error("Expected fetchWithSsrFGuard to be called");
  }
  const [request] = mockCall;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Expected fetchWithSsrFGuard request");
  }
  return request as Record<string, unknown>;
}

describe("provider operation deadlines", () => {
  it("keeps default per-call timeouts when no operation timeout is configured", () => {
    const deadline = createProviderOperationDeadline({
      label: "video generation",
    });

    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(60_000);
  });

  it("clamps per-call timeouts to the remaining operation deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 5_000,
    });

    vi.setSystemTime(4_250);

    expect(resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toBe(1_750);
  });

  it("throws once the operation deadline has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 2_000,
    });

    vi.setSystemTime(3_001);

    expect(() => resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: 60_000 })).toThrow(
      "video generation timed out after 2000ms",
    );
  });

  it("clamps poll waits to the remaining operation deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const deadline = createProviderOperationDeadline({
      label: "video generation",
      timeoutMs: 1_000,
    });
    const wait = waitProviderOperationPollInterval({
      deadline,
      pollIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void wait.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBeUndefined();
  });

  it("polls provider status JSON until a payload is complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "in_progress" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed" })));

    const result = pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
        timeoutMs: 10_000,
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      isComplete: (payload) => payload.status === "completed",
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws provider failure messages while polling status JSON", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "failed", error: { message: "model rejected" } })),
      );

    await expect(
      pollProviderOperationJson<{ status?: string; error?: { message?: string } }>({
        url: "https://api.example.com/v1/videos/task-1",
        headers: new Headers(),
        deadline: createProviderOperationDeadline({
          label: "video generation task task-1",
        }),
        defaultTimeoutMs: 5_000,
        fetchFn,
        maxAttempts: 3,
        pollIntervalMs: 1_000,
        requestFailedMessage: "status failed",
        timeoutMessage: "task timed out",
        isComplete: (payload) => payload.status === "completed",
        getFailureMessage: (payload) =>
          payload.status === "failed" ? payload.error?.message : undefined,
      }),
    ).rejects.toThrow("model rejected");
  });

  it("wraps malformed provider status JSON while polling", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{ nope"));

    await expect(
      pollProviderOperationJson<{ status?: string }>({
        url: "https://api.example.com/v1/videos/task-1",
        headers: new Headers(),
        deadline: createProviderOperationDeadline({
          label: "video generation task task-1",
        }),
        defaultTimeoutMs: 5_000,
        fetchFn,
        maxAttempts: 3,
        pollIntervalMs: 1_000,
        requestFailedMessage: "status failed",
        timeoutMessage: "task timed out",
        isComplete: (payload) => payload.status === "completed",
      }),
    ).rejects.toThrow("status failed: malformed JSON response");
  });

  it("wraps wrong-shaped provider status JSON roots while polling", async () => {
    for (const payload of ["[]", '"completed"', "null"]) {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(payload));

      await expect(
        pollProviderOperationJson<{ status?: string }>({
          url: "https://api.example.com/v1/videos/task-1",
          headers: new Headers(),
          deadline: createProviderOperationDeadline({
            label: "video generation task task-1",
          }),
          defaultTimeoutMs: 5_000,
          fetchFn,
          maxAttempts: 3,
          pollIntervalMs: 1_000,
          requestFailedMessage: "status failed",
          timeoutMessage: "task timed out",
          isComplete: (body) => body.status === "completed",
        }),
      ).rejects.toThrow("status failed: malformed JSON response");
    }
  });

  it("retries transient provider status failures while polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, statusText: "Service Unavailable" }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed" })));

    const result = pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
        timeoutMs: 10_000,
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      isComplete: (payload) => payload.status === "completed",
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual({ status: "completed" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("recomputes remaining poll timeout before retry attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const fetchFn = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(2_001);
      return new Response("busy", { status: 503, statusText: "Service Unavailable" });
    });

    const result = pollProviderOperationJson<{ status?: string }>({
      url: "https://api.example.com/v1/videos/task-1",
      headers: new Headers({ authorization: "Bearer test" }),
      deadline: createProviderOperationDeadline({
        label: "video generation task task-1",
        timeoutMs: 1_000,
      }),
      defaultTimeoutMs: 5_000,
      fetchFn,
      maxAttempts: 3,
      pollIntervalMs: 1_000,
      requestFailedMessage: "status failed",
      timeoutMessage: "task timed out",
      isComplete: (payload) => payload.status === "completed",
    });
    const assertion = expect(result).rejects.toThrow(
      "video generation task task-1 timed out after 1000ms",
    );

    await vi.advanceTimersByTimeAsync(250);

    await assertion;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries transient generated asset downloads", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce(new Response("video-bytes", { status: 200 }));

    const response = await fetchProviderDownloadResponse({
      url: "https://cdn.example.com/video.mp4",
      init: { method: "GET" },
      timeoutMs: 5_000,
      fetchFn,
      provider: "test-video",
      requestFailedMessage: "download failed",
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(await response.text()).toBe("video-bytes");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("recomputes remaining download timeout before retry attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(2_001);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const deadline = createProviderOperationDeadline({
      label: "video download",
      timeoutMs: 1_000,
    });

    await expect(
      fetchProviderDownloadResponse({
        url: "https://cdn.example.com/video.mp4",
        init: { method: "GET" },
        timeoutMs: createProviderOperationTimeoutResolver({ deadline, defaultTimeoutMs: 5_000 }),
        fetchFn,
        provider: "test-video",
        requestFailedMessage: "download failed",
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
      }),
    ).rejects.toThrow("video download timed out after 1000ms");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });
});

describe("resolveProviderHttpRequestConfig", () => {
  it("preserves explicit caller headers but protects attribution headers", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.openai.com/v1/",
      defaultBaseUrl: "https://api.openai.com/v1",
      headers: {
        authorization: "Bearer override",
        "User-Agent": "custom-agent/1.0",
        originator: "spoofed",
      },
      defaultHeaders: {
        authorization: "Bearer default-token",
        "X-Default": "1",
      },
      provider: "openai",
      api: "openai-audio-transcriptions",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Bearer override");
    expect(resolved.headers.get("x-default")).toBe("1");
    expect(resolved.headers.get("user-agent")).toBe(`openclaw/${VERSION}`);
    expect(resolved.headers.get("originator")).toBe("openclaw");
    expect(resolved.headers.get("version")).toBe(VERSION);
  });

  it("uses the fallback base URL without enabling private-network access", () => {
    const resolved = resolveProviderHttpRequestConfig({
      defaultBaseUrl: "https://api.deepgram.com/v1/",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.baseUrl).toBe("https://api.deepgram.com/v1");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("authorization")).toBe("Token test-key");
  });

  it("allows callers to preserve custom-base detection before URL normalization", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
      allowPrivateNetwork: false,
      defaultHeaders: {
        "x-goog-api-key": "test-key",
      },
      provider: "google",
      api: "google-generative-ai",
      capability: "image",
      transport: "http",
    });

    expect(resolved.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolved.allowPrivateNetwork).toBe(false);
    expect(resolved.headers.get("x-goog-api-key")).toBe("test-key");
  });

  it("surfaces dispatcher policy for explicit proxy and mTLS transport overrides", () => {
    const resolved = resolveProviderHttpRequestConfig({
      baseUrl: "https://api.deepgram.com/v1",
      defaultBaseUrl: "https://api.deepgram.com/v1",
      defaultHeaders: {
        authorization: "Token test-key",
      },
      request: {
        proxy: {
          mode: "explicit-proxy",
          url: "http://proxy.internal:8443",
          tls: {
            ca: "proxy-ca",
          },
        },
        tls: {
          cert: "client-cert",
          key: "client-key",
        },
      },
      provider: "deepgram",
      capability: "audio",
      transport: "media-understanding",
    });

    expect(resolved.dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://proxy.internal:8443",
      proxyTls: {
        ca: "proxy-ca",
      },
    });
  });

  it("fails fast when no base URL can be resolved", () => {
    expect(() =>
      resolveProviderHttpRequestConfig({
        baseUrl: "   ",
        defaultBaseUrl: "   ",
      }),
    ).toThrow("Missing baseUrl");
  });
});

describe("readErrorResponse", () => {
  it("caps streamed error bodies instead of buffering the whole response", async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          reads += 1;
          controller.enqueue(encoder.encode("a".repeat(2048)));
          if (reads >= 10) {
            controller.close();
          }
        },
      }),
      {
        status: 500,
      },
    );

    const detail = await readErrorResponse(response);

    expect(detail).toBe(`${"a".repeat(300)}…`);
    expect(reads).toBe(2);
  });
});

describe("fetchWithTimeoutGuarded", () => {
  it("applies a default timeout when callers omit one", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetch);

    const call = getFirstGuardedFetchCall();
    expect(call.url).toBe("https://example.com");
    expect(call.timeoutMs).toBe(60_000);
  });

  it("sanitizes auditContext before passing it to the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, 5000, fetch, {
      auditContext: "provider-http\r\nfal\timage\u001btest",
    });

    const call = getFirstGuardedFetchCall();
    expect(call.auditContext).toBe("provider-http fal image test");
    expect(call.timeoutMs).toBe(5000);
  });

  it("passes configured explicit proxy policy through the SSRF guard", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.deepgram.com/v1/listen",
      headers: new Headers({ authorization: "Token test-key" }),
      body: { hello: "world" },
      fetchFn: fetch,
      dispatcherPolicy: {
        mode: "explicit-proxy",
        proxyUrl: "http://169.254.169.254:8080",
      },
    });

    expect(getFirstGuardedFetchCall().dispatcherPolicy).toEqual({
      mode: "explicit-proxy",
      proxyUrl: "http://169.254.169.254:8080",
    });
  });

  it("merges full SSRF policy into JSON request guards", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/test",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
      allowPrivateNetwork: true,
      ssrfPolicy: { allowRfc2544BenchmarkRange: true },
    });

    expect(getFirstGuardedFetchCall().policy).toEqual({
      allowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("forwards explicit pinDns overrides to JSON requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/test",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
      pinDns: false,
    });

    expect(getFirstGuardedFetchCall().pinDns).toBe(false);
  });

  it("does not retry JSON POST requests by default", async () => {
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://api.example.com",
        release: async () => {},
      });

    await expect(
      postJsonRequest({
        url: "https://api.example.com/v1/create",
        headers: new Headers(),
        body: { prompt: "make a video" },
        fetchFn: fetch,
      }),
    ).rejects.toThrow("socket hang up");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("retries JSON POST requests only when marked as read operations", async () => {
    fetchWithSsrFGuardMock.mockReset();
    const sleep = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://api.example.com",
        release: async () => {},
      });

    await expect(
      postJsonRequest({
        url: "https://api.example.com/v1/analyze",
        headers: new Headers(),
        body: { media: "base64" },
        fetchFn: fetch,
        retryStage: "read",
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
      }),
    ).resolves.toEqual(expect.objectContaining({ finalUrl: "https://api.example.com" }));

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("retries read JSON POST transient HTTP responses", async () => {
    fetchWithSsrFGuardMock.mockReset();
    const firstRelease = vi.fn(async () => undefined);
    const secondRelease = vi.fn(async () => undefined);
    const sleep = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response("busy", { status: 503, statusText: "Service Unavailable" }),
        finalUrl: "https://api.example.com",
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://api.example.com",
        release: secondRelease,
      });

    const result = await postJsonRequest({
      url: "https://api.example.com/v1/analyze",
      headers: new Headers(),
      body: { media: "base64" },
      fetchFn: fetch,
      retryStage: "read",
      retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
    });

    expect(result.response.status).toBe(200);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledOnce();
    expect(secondRelease).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("forwards explicit pinDns overrides to transcription requests", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await postTranscriptionRequest({
      url: "https://api.example.com/v1/transcriptions",
      headers: new Headers(),
      body: "audio-bytes",
      fetchFn: fetch,
      pinDns: false,
    });

    expect(getFirstGuardedFetchCall().pinDns).toBe(false);
  });

  it("does not retry transcription POST requests by default", async () => {
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://api.example.com",
        release: async () => {},
      });

    await expect(
      postTranscriptionRequest({
        url: "https://api.example.com/v1/transcriptions",
        headers: new Headers(),
        body: "audio-bytes",
        fetchFn: fetch,
      }),
    ).rejects.toThrow("socket hang up");

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
  });

  it("retries transcription POST requests only when marked as read operations", async () => {
    fetchWithSsrFGuardMock.mockReset();
    const sleep = vi.fn(async () => undefined);
    fetchWithSsrFGuardMock
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({
        response: new Response(null, { status: 200 }),
        finalUrl: "https://api.example.com",
        release: async () => {},
      });

    await expect(
      postTranscriptionRequest({
        url: "https://api.example.com/v1/transcriptions",
        headers: new Headers(),
        body: "audio-bytes",
        fetchFn: fetch,
        retryStage: "read",
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
      }),
    ).resolves.toEqual(expect.objectContaining({ finalUrl: "https://api.example.com" }));

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0, undefined);
  });

  it("does not set a guarded fetch mode when no HTTP proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://example.com", {}, undefined, fetch);

    const call = getFirstGuardedFetchCall();
    expect(call).not.toHaveProperty("mode");
  });

  it("auto-selects trusted env proxy mode when HTTP proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.minimax.io",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.minimax.io/v1/image_generation",
      headers: new Headers({ authorization: "Bearer test" }),
      body: { model: "image-01", prompt: "a red cube" },
      fetchFn: fetch,
    });

    expect(getFirstGuardedFetchCall().mode).toBe("trusted_env_proxy");
  });

  it("respects an explicit mode from the caller when HTTP proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await fetchWithTimeoutGuarded("https://api.example.com", {}, undefined, fetch, {
      mode: "strict",
    });

    expect(getFirstGuardedFetchCall().mode).toBe("strict");
  });

  it("auto-upgrades transcription requests to trusted env proxy when proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.openai.com",
      release: async () => {},
    });

    await postTranscriptionRequest({
      url: "https://api.openai.com/v1/audio/transcriptions",
      headers: new Headers({ authorization: "Bearer test" }),
      body: "audio-bytes",
      fetchFn: fetch,
    });

    expect(getFirstGuardedFetchCall().mode).toBe("trusted_env_proxy");
  });

  it("forwards an explicit mode override through postJsonRequest even when proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/strict",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
      mode: "strict",
    });

    expect(getFirstGuardedFetchCall().mode).toBe("strict");
  });

  it("forwards an explicit mode override through postTranscriptionRequest even when proxy env is configured", async () => {
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await postTranscriptionRequest({
      url: "https://api.example.com/v1/transcriptions",
      headers: new Headers(),
      body: "audio-bytes",
      fetchFn: fetch,
      mode: "strict",
    });

    expect(getFirstGuardedFetchCall().mode).toBe("strict");
  });

  it("does not auto-upgrade when only ALL_PROXY is configured (HTTP(S) proxy gate)", async () => {
    // ALL_PROXY is ignored by EnvHttpProxyAgent; the shared proxy URL helper
    // reflects that by returning false when only ALL_PROXY is set. Auto-upgrade
    // must NOT fire, otherwise the request would skip pinned-DNS/SSRF checks
    // and then be dispatched directly.
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://api.example.com/v1/image",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
    });

    const call = getFirstGuardedFetchCall();
    expect(call).not.toHaveProperty("mode");
  });

  it("does not auto-upgrade when caller passes explicit dispatcherPolicy", async () => {
    // Callers with custom proxy URL / proxyTls / connect options must keep
    // control over the dispatcher. Auto-upgrade would build an
    // EnvHttpProxyAgent that silently drops those overrides.
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://api.example.com",
      release: async () => {},
    });

    const explicitPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: "http://corp-proxy.internal:3128",
    };

    await fetchWithTimeoutGuarded("https://api.example.com/v1/image", {}, undefined, fetch, {
      dispatcherPolicy: explicitPolicy,
    });

    const call = getFirstGuardedFetchCall();
    expect(call).not.toHaveProperty("mode");
    expect(call).toHaveProperty("dispatcherPolicy", explicitPolicy);
  });

  it("does not auto-upgrade when target URL matches NO_PROXY", async () => {
    // With HTTP_PROXY + NO_PROXY, EnvHttpProxyAgent makes direct connections
    // for NO_PROXY matches, but in TRUSTED_ENV_PROXY mode fetchWithSsrFGuard
    // skips pinned-DNS checks — so auto-upgrading those targets would bypass
    // SSRF protection. Keep strict mode for NO_PROXY matches.
    shouldUseEnvHttpProxyForUrlMock.mockReturnValue(false);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      finalUrl: "https://internal.corp.example",
      release: async () => {},
    });

    await postJsonRequest({
      url: "https://internal.corp.example/v1/image",
      headers: new Headers(),
      body: { ok: true },
      fetchFn: fetch,
    });

    const call = getFirstGuardedFetchCall();
    expect(call).not.toHaveProperty("mode");
  });
});
