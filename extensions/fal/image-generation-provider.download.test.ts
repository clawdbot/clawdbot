// Fal tests cover generated image download response validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { buildFalImageGenerationProvider } from "./image-generation-provider.js";

const falApiKey = { apiKey: "fal-test-key", source: "env", mode: "api-key" } as const;
const downloadUrl = "https://v3.fal.media/files/example/generated.png";

function releasedJson(payload: unknown) {
  return { response: Response.json(payload), release: vi.fn(async () => {}) };
}

/** Builds a download response from a real body stream, as fetch would. */
function releasedBody(body: BodyInit, headers?: Record<string, string>) {
  const release = vi.fn(async () => {});
  return {
    response: new Response(body, { status: 200, ...(headers ? { headers } : {}) }),
    release,
  };
}

function streamed(bytes: string, headers?: Record<string, string>) {
  return releasedBody(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(bytes));
        controller.close();
      },
    }),
    headers,
  );
}

describe("fal generated image download response validation", () => {
  let provider: ReturnType<typeof buildFalImageGenerationProvider>;

  beforeEach(() => {
    provider = buildFalImageGenerationProvider();
    fetchWithSsrFGuardMock.mockReset();
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue(falApiKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function generate() {
    return provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "draw a cat",
      cfg: {},
    });
  }

  function respondWith(download: ReturnType<typeof releasedBody>) {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(releasedJson({ images: [{ url: downloadUrl }] }))
      .mockResolvedValueOnce(download);
    return download;
  }

  it.each([
    {
      label: "a JSON error payload",
      download: () =>
        streamed('{"error":"quota exceeded"}', { "content-type": "application/json" }),
    },
    {
      label: "a problem+json payload",
      download: () => streamed('{"title":"gone"}', { "content-type": "application/problem+json" }),
    },
    {
      label: "an HTML sign-in page",
      download: () =>
        streamed("<html><body>sign in</body></html>", { "content-type": "text/html" }),
    },
    {
      label: "plain text",
      download: () => streamed("not an image", { "content-type": "text/plain; charset=utf-8" }),
    },
    {
      label: "an empty body under an image content type",
      download: () => streamed("", { "content-type": "image/png" }),
    },
  ])("rejects a successful download that returns $label", async ({ download }) => {
    const handle = respondWith(download());

    await expect(generate()).rejects.toThrow(
      "fal generated image download: malformed image response",
    );
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the image/png default when the provider omits a content type", async () => {
    respondWith(streamed("png-bytes"));

    const result = await generate();

    expect(result.images[0]?.mimeType).toBe("image/png");
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png-bytes"));
  });

  it("delivers a well-formed image download unchanged", async () => {
    respondWith(streamed("png-bytes", { "content-type": "image/webp" }));

    const result = await generate();

    expect(result.images[0]?.mimeType).toBe("image/webp");
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png-bytes"));
  });

  it("keeps the existing byte-cap message rather than the shared reader default", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce(releasedJson({ images: [{ url: downloadUrl }] }))
      .mockResolvedValueOnce(streamed("too-large", { "content-type": "image/png" }));

    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "draw a cat",
        cfg: { agents: { defaults: { mediaMaxMb: 0.000001 } } },
      }),
    ).rejects.toThrow("fal generated image download exceeds 1 bytes");
  });
});
