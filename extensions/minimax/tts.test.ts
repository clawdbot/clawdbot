// Minimax tests cover tts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import { minimaxTTS } from "./tts.js";

describe("minimaxTTS", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    vi.restoreAllMocks();
  });

  it("caps oversized request timeout before arming abort timers", async () => {
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(0 as unknown as ReturnType<typeof setTimeout>);
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({ data: { audio: Buffer.from("audio").toString("hex") } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    const audio = await minimaxTTS({
      text: "hello",
      apiKey: "sk-test",
      baseUrl: "https://api.minimax.io",
      model: "speech-2.8-hd",
      voiceId: "English_expressive_narrator",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(audio.toString()).toBe("audio");
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on base_resp envelope error even when data.audio is present (regression #76904)", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          data: { audio: Buffer.from("placeholder").toString("hex") },
          base_resp: { status_code: 1002, status_msg: "Quota exceeded" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    await expect(
      minimaxTTS({
        text: "hello",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("MiniMax TTS API error (1002): Quota exceeded");
  });

  it("throws on base_resp envelope error with empty audio", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          base_resp: { status_code: 1001, status_msg: "Rate limit" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    await expect(
      minimaxTTS({
        text: "hello",
        apiKey: "sk-test",
        baseUrl: "https://api.minimax.io",
        model: "speech-2.8-hd",
        voiceId: "English_expressive_narrator",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("MiniMax TTS API error (1001): Rate limit");
  });

  it("succeeds when base_resp.status_code is 0", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          data: { audio: Buffer.from("real-audio").toString("hex") },
          base_resp: { status_code: 0, status_msg: "success" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      release: vi.fn(async () => undefined),
    });

    const audio = await minimaxTTS({
      text: "hello",
      apiKey: "sk-test",
      baseUrl: "https://api.minimax.io",
      model: "speech-2.8-hd",
      voiceId: "English_expressive_narrator",
      timeoutMs: 10_000,
    });

    expect(audio.toString()).toBe("real-audio");
  });
});
