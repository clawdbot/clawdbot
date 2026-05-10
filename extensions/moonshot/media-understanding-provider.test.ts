import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { describeMoonshotVideo } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

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
});
