import { describe, expect, it, vi } from "vitest";
import {
  buildXaiMediaUnderstandingProvider,
  transcribeXaiAudio,
  XAI_DEFAULT_STT_MODEL,
} from "./stt.js";

const { postTranscriptionRequestMock } = vi.hoisted(() => ({
  postTranscriptionRequestMock: vi.fn(
    async (_params: { headers: Headers; body: BodyInit; url: string; timeoutMs?: number }) => ({
      response: new Response(JSON.stringify({ text: "hello from audio" }), { status: 200 }),
      release: vi.fn(),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    postTranscriptionRequest: postTranscriptionRequestMock,
  };
});

describe("xai stt", () => {
  it("posts audio files to the xAI STT endpoint", async () => {
    const result = await transcribeXaiAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "sample.wav",
      mime: "audio/wav",
      apiKey: "xai-key",
      baseUrl: "https://api.x.ai/v1/",
      model: XAI_DEFAULT_STT_MODEL,
      language: "en",
      prompt: "ignored provider hint",
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ text: "hello from audio", model: XAI_DEFAULT_STT_MODEL });
    expect(postTranscriptionRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.x.ai/v1/stt",
        timeoutMs: 10_000,
        auditContext: "xai stt",
      }),
    );
    const call = postTranscriptionRequestMock.mock.calls[0]?.[0];
    expect(call?.headers.get("authorization")).toBe("Bearer xai-key");
    expect(call?.body).toBeInstanceOf(FormData);
    const form = call?.body as FormData;
    expect(form.get("model")).toBe(XAI_DEFAULT_STT_MODEL);
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBeNull();
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("registers as an audio media-understanding provider", () => {
    expect(buildXaiMediaUnderstandingProvider()).toMatchObject({
      id: "xai",
      capabilities: ["audio"],
      defaultModels: { audio: XAI_DEFAULT_STT_MODEL },
      autoPriority: { audio: 25 },
    });
  });
});
