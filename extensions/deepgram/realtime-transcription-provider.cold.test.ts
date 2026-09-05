import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("openclaw/plugin-sdk/realtime-transcription");
  vi.resetModules();
});

it("constructs the provider without importing the broad transcription SDK", async () => {
  vi.resetModules();
  vi.doMock("openclaw/plugin-sdk/realtime-transcription", () => {
    throw new Error("provider construction imported the broad transcription SDK");
  });

  const { buildDeepgramRealtimeTranscriptionProvider } =
    await import("./realtime-transcription-provider.js");
  const provider = buildDeepgramRealtimeTranscriptionProvider();
  expect(provider.id).toBe("deepgram");
  expect(provider.aliases).toContain("deepgram-realtime");
  expect(provider.createSession).toBeTypeOf("function");
});
