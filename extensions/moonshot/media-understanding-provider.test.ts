import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.ts";
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
      model: "kimi-k2.5",
      headers: { "X-Trace": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.text).toBe("video ok");
    expect(result.model).toBe("kimi-k2.5");
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer moonshot-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trace")).toBe("1");

    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      model?: string;
      messages?: Array<{
        content?: Array<{ type?: string; text?: string; video_url?: { url?: string } }>;
      }>;
    };
    expect(body.model).toBe("kimi-k2.5");
    expect(body.messages?.[0]?.content?.[0]).toMatchObject({
      type: "text",
      text: "Describe the video.",
    });
    expect(body.messages?.[0]?.content?.[1]?.type).toBe("video_url");
    expect(body.messages?.[0]?.content?.[1]?.video_url?.url).toBe(
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
    expect(result.model).toBe("kimi-k2.5");
  });
});
