import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { describeQwenVideo } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("describeQwenVideo", () => {
  it("builds the expected OpenAI-compatible video payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [
        {
          message: {
            content: [{ text: " first " }, { text: "second" }],
          },
        },
      ],
    });

    const result = await describeQwenVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.mp4",
      mime: "video/mp4",
      apiKey: "test-key",
      timeoutMs: 1500,
      baseUrl: "https://example.com/v1",
      model: "qwen-vl-max",
      prompt: "summarize the clip",
      headers: { "X-Other": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.model).toBe("qwen-vl-max");
    expect(result.text).toBe("first\nsecond");
    expect(url).toBe("https://example.com/v1/chat/completions");
    if (!init) {
      throw new Error("expected Qwen request init");
    }
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-other")).toBe("1");

    const bodyText =
      typeof init.body === "string"
        ? init.body
        : Buffer.isBuffer(init.body)
          ? init.body.toString("utf8")
          : "";
    expect(bodyText).not.toBe("");
    const body = JSON.parse(bodyText);
    expect(body.model).toBe("qwen-vl-max");
    const content = body.messages?.[0]?.content;
    if (!content) {
      throw new Error("expected Qwen user content");
    }
    expect(content[0]?.text).toBe("summarize the clip");
    const videoContent = content[1];
    if (!videoContent) {
      throw new Error("expected Qwen video content");
    }
    expect(videoContent.type).toBe("video_url");
    if (!videoContent.video_url) {
      throw new Error("expected Qwen video URL payload");
    }
    expect(videoContent.video_url.url).toBe(
      `data:video/mp4;base64,${Buffer.from("video-bytes").toString("base64")}`,
    );
  });
});
