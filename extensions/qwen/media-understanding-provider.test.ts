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
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-other")).toBe("1");

    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : Buffer.isBuffer(init?.body)
          ? init.body.toString("utf8")
          : "";
    const body = JSON.parse(bodyText);
    expect(body.model).toBe("qwen-vl-max");
    expect(body.messages?.[0]?.content?.[0]?.text).toBe("summarize the clip");
    expect(body.messages?.[0]?.content?.[1]?.type).toBe("video_url");
    expect(body.messages?.[0]?.content?.[1]?.video_url?.url).toBe(
      `data:video/mp4;base64,${Buffer.from("video-bytes").toString("base64")}`,
    );
  });
});
