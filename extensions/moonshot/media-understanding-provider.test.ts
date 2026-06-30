// Moonshot tests cover media understanding provider plugin behavior.
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { describeMoonshotVideo } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

function oversizedJsonResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
} {
  const chunk = new Uint8Array(params.chunkSize);
  let readCount = 0;
  let canceled = false;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (readCount >= params.chunkCount) {
            controller.close();
            return;
          }
          readCount += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    ),
    getReadCount: () => readCount,
    wasCanceled: () => canceled,
  };
}

describe("describeMoonshotVideo", () => {
  it("builds an OpenAI-compatible video request", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "video ok" } }],
    });

    const result = await describeMoonshotVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      apiKey: "moonshot-test",
      timeoutMs: 1500,
      baseUrl: "https://api.moonshot.ai/v1/",
      model: "kimi-k2.6",
      headers: { "X-Trace": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.text).toBe("video ok");
    expect(result.model).toBe("kimi-k2.6");
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    if (!init) {
      throw new Error("expected Moonshot request init");
    }
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer moonshot-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trace")).toBe("1");

    expect(init.body).toBeTypeOf("string");
    if (typeof init.body !== "string") {
      throw new Error("expected Moonshot JSON request body");
    }
    const body = JSON.parse(init.body) as {
      model?: string;
      messages?: Array<{
        content?: Array<{ type?: string; text?: string; video_url?: { url?: string } }>;
      }>;
    };
    expect(body.model).toBe("kimi-k2.6");
    const content = body.messages?.[0]?.content;
    if (!content) {
      throw new Error("expected Moonshot user content");
    }
    const [textContent] = content;
    if (!textContent) {
      throw new Error("expected Moonshot text content");
    }
    expect(textContent.type).toBe("text");
    expect(textContent.text).toBe("Describe the video.");
    const videoContent = content[1];
    if (!videoContent) {
      throw new Error("expected Moonshot video content");
    }
    expect(videoContent.type).toBe("video_url");
    if (!videoContent.video_url) {
      throw new Error("expected Moonshot video URL payload");
    }
    expect(videoContent.video_url.url).toBe(
      `data:video/mp4;base64,${Buffer.from("video-bytes").toString("base64")}`,
    );
  });

  it("falls back to reasoning_content when content is empty", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "", reasoning_content: "reasoned answer" } }],
    });

    const result = await describeMoonshotVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "moonshot-test",
      timeoutMs: 1000,
      fetchFn,
    });

    expect(result.text).toBe("reasoned answer");
    expect(result.model).toBe("kimi-k2.6");
  });

  it("bounds successful Moonshot video JSON bodies instead of buffering the whole response", async () => {
    const streamed = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });

    await expect(
      describeMoonshotVideo({
        buffer: Buffer.from("video-bytes"),
        fileName: "clip.mp4",
        mime: "video/mp4",
        apiKey: "test-key",
        timeoutMs: 1500,
        baseUrl: "https://example.com/v1",
        fetchFn: async () => streamed.response,
      }),
    ).rejects.toThrow("Moonshot video description failed: JSON response exceeds 16777216 bytes");

    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("reports malformed Moonshot video JSON with a provider-owned error", async () => {
    const response = new Response("not-json{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await expect(
      describeMoonshotVideo({
        buffer: Buffer.from("video-bytes"),
        fileName: "clip.mp4",
        mime: "video/mp4",
        apiKey: "test-key",
        timeoutMs: 1500,
        baseUrl: "https://example.com/v1",
        fetchFn: async () => response,
      }),
    ).rejects.toThrow("Moonshot video description failed: malformed JSON response");
  });
});
