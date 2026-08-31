// Covers the network allowance the xAI TTS synthesis request carries.
import { describe, expect, it, vi } from "vitest";

const { postJsonRequestMock } = vi.hoisted(() => ({
  postJsonRequestMock: vi.fn(async () => {
    throw new Error("stop after the request is built");
  }),
}));

vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  postJsonRequest: postJsonRequestMock,
}));

const { xaiTTS } = await import("./tts.js");

describe("xaiTTS network allowance", () => {
  it("passes the configured base url hostname allowance to synthesis", async () => {
    postJsonRequestMock.mockClear();

    await expect(
      xaiTTS({
        text: "hello",
        apiKey: "key",
        baseUrl: "https://tts.example.com/v1",
        voiceId: "voice",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/stop after the request is built/);

    const params = postJsonRequestMock.mock.calls[0]?.[0] as
      | { ssrfPolicy?: { allowedHostnames?: string[] } }
      | undefined;
    expect(params?.ssrfPolicy).toBeDefined();
    expect(params?.ssrfPolicy?.allowedHostnames).toEqual(["tts.example.com"]);
  });
});
