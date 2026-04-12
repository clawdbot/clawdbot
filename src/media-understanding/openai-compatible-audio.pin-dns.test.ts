import { afterEach, describe, expect, it, vi } from "vitest";

const { postTranscriptionRequestMock } = vi.hoisted(() => ({
  postTranscriptionRequestMock: vi.fn(),
}));

vi.mock("./shared.js", async () => {
  const actual = await vi.importActual<typeof import("./shared.js")>("./shared.js");
  return {
    ...actual,
    postTranscriptionRequest: postTranscriptionRequestMock,
  };
});

import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("transcribeOpenAiCompatibleAudio pinDns", () => {
  it("disables pinned DNS only for the multipart OpenAI-compatible request", async () => {
    postTranscriptionRequestMock.mockResolvedValue({
      response: new Response(JSON.stringify({ text: "ok" }), { status: 200 }),
      release: async () => {},
    });

    const result = await transcribeOpenAiCompatibleAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      apiKey: "test-key",
      timeoutMs: 1000,
      fetchFn: fetch,
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4o-transcribe",
    });

    expect(result.text).toBe("ok");
    expect(postTranscriptionRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pinDns: false,
        body: expect.any(FormData),
      }),
    );
  });
});
