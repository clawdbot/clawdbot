// Openai tests cover realtime session secret creation behavior.
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAIRealtimeClientSecret,
  createOpenAIRealtimeTranscriptionClientSecret,
} from "./realtime-provider-shared.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

function makeStreamingResponse(params: { chunkCount: number; chunkSize: number }): {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
} {
  let readCount = 0;
  let canceled = false;
  const chunk = new Uint8Array(params.chunkSize);
  const response = new Response(
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
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  return { response, getReadCount: () => readCount, wasCanceled: () => canceled };
}

function guardedFetch(response: Response): void {
  fetchWithSsrFGuardMock.mockResolvedValue({ response, release: vi.fn() });
}

describe("createOpenAIRealtimeClientSecret", () => {
  it("returns client secret from a well-formed response", async () => {
    guardedFetch(
      new Response(
        JSON.stringify({
          client_secret: { value: "eph-secret-abc" },
          expires_at: Math.floor(Date.now() / 1000) + 60,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await createOpenAIRealtimeClientSecret({
      authToken: "sk-test",
      auditContext: "test",
      session: { model: "gpt-4o-realtime-preview" },
    });

    expect(result.value).toBe("eph-secret-abc");
    expect(typeof result.expiresAt).toBe("number");
    expect(fetchWithSsrFGuardMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("bounds oversized success response and cancels the stream", async () => {
    // 20 MiB in 1 MiB chunks — well over the 16 MiB cap
    const streamed = makeStreamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });
    guardedFetch(streamed.response);

    await expect(
      createOpenAIRealtimeClientSecret({
        authToken: "sk-test",
        auditContext: "test",
        session: { model: "gpt-4o-realtime-preview" },
      }),
    ).rejects.toThrow(/openai\.realtime-session/);

    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("throws the provider error label on oversized body", async () => {
    const streamed = makeStreamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });
    guardedFetch(streamed.response);

    await expect(
      createOpenAIRealtimeTranscriptionClientSecret({
        authToken: "sk-test",
        auditContext: "test",
        session: { model: "gpt-4o-transcribe" },
      }),
    ).rejects.toThrow(/openai\.realtime-session/);

    expect(streamed.wasCanceled()).toBe(true);
  });

  it("creates transcription secrets through the current client-secrets endpoint", async () => {
    guardedFetch(
      new Response(JSON.stringify({ value: "ek-transcription", expires_at: 1_800_000_000 }), {
        status: 200,
      }),
    );

    await createOpenAIRealtimeTranscriptionClientSecret({
      authToken: "sk-test",
      auditContext: "test",
      session: { type: "transcription" },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.openai.com/v1/realtime/client_secrets",
        timeoutMs: 30_000,
        init: expect.objectContaining({
          body: JSON.stringify({ session: { type: "transcription" } }),
        }),
      }),
    );
  });

  it("replaces rejected transcription API-key details with bounded guidance", async () => {
    guardedFetch(
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided: secret" } }), {
        status: 401,
      }),
    );

    await expect(
      createOpenAIRealtimeTranscriptionClientSecret({
        authToken: "sk-test",
        auditContext: "test",
        session: { type: "transcription" },
        authRejectedMessage: "Update the transcription API key",
      }),
    ).rejects.toThrow("Update the transcription API key");
  });
});
