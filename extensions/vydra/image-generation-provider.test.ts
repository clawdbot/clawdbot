import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVydraImageGenerationProvider } from "./image-generation-provider.js";

describe("vydra image-generation provider", () => {
  installPinnedHostnameTestHooks();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts to the www api and downloads the generated image", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "vydra-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job-123",
            status: "completed",
            imageUrl: "https://cdn.vydra.ai/generated/test.png",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("png-data"), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildVydraImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "vydra",
      model: "grok-imagine",
      prompt: "draw a cat",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.vydra.ai/api/v1/models/grok-imagine",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "draw a cat",
          model: "text-to-image",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer vydra-test-key");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "grok-imagine",
      metadata: {
        jobId: "job-123",
        imageUrl: "https://cdn.vydra.ai/generated/test.png",
        status: "completed",
      },
    });
  });

  it("polls jobs when the create response is not completed yet", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "vydra-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-456", status: "queued" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "job-456",
            status: "completed",
            resultUrls: ["https://cdn.vydra.ai/generated/polled.png"],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from("png-data"), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildVydraImageGenerationProvider();
    await provider.generateImage({
      provider: "vydra",
      model: "grok-imagine",
      prompt: "draw a cat",
      cfg: {},
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.vydra.ai/api/v1/jobs/job-456",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
