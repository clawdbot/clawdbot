import { withFetchPreconnect } from "openclaw/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.js";
import { describeGeminiVideo } from "./media-understanding-provider.js";
import { resolveGoogleGenerativeAiHttpRequestConfig } from "./runtime-api.js";

installPinnedHostnameTestHooks();

describe("describeGeminiVideo", () => {
  it("respects case-insensitive x-goog-api-key overrides", async () => {
    let seenKey: string | null = null;
    const fetchFn = withFetchPreconnect(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenKey = headers.get("x-goog-api-key");
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "video ok" }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await describeGeminiVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "test-key",
      timeoutMs: 1000,
      headers: { "X-Goog-Api-Key": "override" },
      fetchFn,
    });

    expect(seenKey).toBe("override");
    expect(result.text).toBe("video ok");
  });

  it("keeps private-network disabled for the default Google media endpoint", async () => {
    expect(
      resolveGoogleGenerativeAiHttpRequestConfig({
        apiKey: "test-key",
        capability: "video",
        transport: "media-understanding",
      }).allowPrivateNetwork,
    ).toBe(false);

    const fetchFn = withFetchPreconnect(async () => {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "video ok" }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await describeGeminiVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn,
    });
  });

  it("builds the expected request payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      candidates: [
        {
          content: {
            parts: [{ text: "first" }, { text: " second " }, { text: "" }],
          },
        },
      ],
    });

    const result = await describeGeminiVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      apiKey: "test-key",
      timeoutMs: 1500,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
      model: "gemini-3-pro",
      headers: { "X-Other": "1" },
      fetchFn,
    });
    const { url: seenUrl, init: seenInit } = getRequest();

    expect(result.model).toBe("gemini-3-pro-preview");
    expect(result.text).toBe("first\nsecond");
    expect(seenUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent",
    );
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(seenInit?.headers);
    expect(headers.get("x-goog-api-key")).toBe("test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-other")).toBe("1");

    const bodyText =
      typeof seenInit?.body === "string"
        ? seenInit.body
        : Buffer.isBuffer(seenInit?.body)
          ? seenInit.body.toString("utf8")
          : "";
    const body = JSON.parse(bodyText);
    expect(body.contents?.[0]?.parts?.[0]?.text).toBe("Describe the video.");
    expect(body.contents?.[0]?.parts?.[1]?.inline_data?.mime_type).toBe("video/mp4");
    expect(body.contents?.[0]?.parts?.[1]?.inline_data?.data).toBe(
      Buffer.from("video-bytes").toString("base64"),
    );
  });

  it("rejects non-Google video base URLs before sending authenticated requests", async () => {
    await expect(
      describeGeminiVideo({
        buffer: Buffer.from("video-bytes"),
        fileName: "clip.mp4",
        apiKey: "test-key",
        timeoutMs: 1500,
        baseUrl: "https://example.com/v1beta/",
        fetchFn: async () => {
          throw new Error("fetch should not run");
        },
      }),
    ).rejects.toThrow(
      "Google Generative AI baseUrl must use https://generativelanguage.googleapis.com",
    );
  });
});
