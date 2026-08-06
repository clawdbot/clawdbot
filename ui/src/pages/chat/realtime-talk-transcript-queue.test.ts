// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

const transportMock = vi.hoisted(() => ({
  context: undefined as RealtimeTalkTransportContext | undefined,
  start: vi.fn(async () => "ready" as const),
  stop: vi.fn(),
}));

vi.mock("./realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: vi.fn(),
}));
vi.mock("./realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: vi.fn(),
}));
vi.mock("./realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.context = context;
    return { start: transportMock.start, stop: transportMock.stop };
  }),
}));

import { RealtimeTalkSession } from "./realtime-talk.ts";

describe("RealtimeTalkSession transcript queue", () => {
  beforeEach(() => {
    transportMock.context = undefined;
    transportMock.start.mockClear();
    transportMock.stop.mockClear();
  });

  it("does not admit normalized-empty finals into a stalled transcript queue", async () => {
    let releaseFirstTranscript!: () => void;
    const firstTranscriptPending = new Promise<void>((resolve) => {
      releaseFirstTranscript = resolve;
    });
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-empty-finals",
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        transcriptEntryIds.push(String(params?.entryId));
        if (params?.entryId === "1") {
          await firstTranscriptPending;
        }
      }
      return { ok: true };
    });
    const onStatus = vi.fn();
    const onTranscript = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onStatus,
      onTranscript,
    });
    await session.start();
    const context = transportMock.context;
    const handleTranscript = context?.callbacks.onTranscript;
    if (!context || !handleTranscript) {
      throw new Error("expected realtime transcript callback");
    }

    handleTranscript({ role: "user", text: "first", final: true });
    for (let index = 0; index < 10_000; index += 1) {
      handleTranscript({ role: "assistant", text: "   ", final: true });
    }
    for (let index = 0; index < 40; index += 1) {
      handleTranscript({ role: "assistant", text: `queued-${index}`, final: true });
    }

    expect(transcriptEntryIds).toEqual(["1"]);
    expect(transportMock.stop).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(0);
    expect(onTranscript).toHaveBeenCalledTimes(10_041);

    releaseFirstTranscript();
    await context.flushTranscriptWrites?.();

    expect(transcriptEntryIds).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
    session.stop();
  });

  it("stops once when stalled transcript persistence exceeds its bounded queue", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let releaseFirstTranscript!: () => void;
    const firstTranscriptPending = new Promise<void>((resolve) => {
      releaseFirstTranscript = resolve;
    });
    const transcriptEntryIds: string[] = [];
    let firstAttempt = true;
    try {
      const request = vi.fn(
        async (method: string, params?: { entryId?: string; text?: string }) => {
          if (method === "talk.client.create") {
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-overflow",
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.transcript") {
            transcriptEntryIds.push(String(params?.entryId));
            if (params?.entryId === "1") {
              if (firstAttempt) {
                firstAttempt = false;
                await firstTranscriptPending;
              }
              throw new Error("still unavailable");
            }
          }
          return { ok: true };
        },
      );
      const onStatus = vi.fn();
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
        onStatus,
      });
      await session.start();
      const onTranscript = transportMock.context?.callbacks.onTranscript;
      if (!onTranscript) {
        throw new Error("expected realtime transcript callback");
      }

      for (let index = 0; index < 10_000; index += 1) {
        onTranscript({
          role: index % 2 === 0 ? "user" : "assistant",
          text: `  ${"x".repeat(9_000)}  `,
          final: true,
        });
      }

      expect(transcriptEntryIds).toEqual(["1"]);
      expect(transportMock.stop).toHaveBeenCalledOnce();
      expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        0,
      );

      releaseFirstTranscript();
      await vi.advanceTimersByTimeAsync(2_500);
      await vi.runAllTimersAsync();

      expect(transcriptEntryIds).toEqual([
        "1",
        "1",
        "1",
        ...Array.from({ length: 40 }, (_, index) => String(index + 2)),
      ]);
      expect(
        request.mock.calls
          .filter(([method]) => method === "talk.client.transcript")
          .every(([, params]) => String(params?.text).length === 8_000),
      ).toBe(true);
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      );
      expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(2);

      onTranscript({ role: "user", text: "too late", final: true });
      session.stop();
      await Promise.resolve();
      expect(transcriptEntryIds).toHaveLength(43);
      expect(transportMock.stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a detached transcript drain before releasing its client owner", async () => {
    vi.useFakeTimers();
    const transcriptSignals: AbortSignal[] = [];
    const closeSignals: AbortSignal[] = [];
    try {
      const request = vi.fn(
        async (
          method: string,
          _params?: unknown,
          options?: { signal?: AbortSignal; timeoutMs?: number },
        ) => {
          if (method === "talk.client.create") {
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-drain-timeout",
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.transcript") {
            const signal = options?.signal;
            if (!signal) {
              throw new Error("expected transcript abort signal");
            }
            transcriptSignals.push(signal);
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          if (method === "talk.client.close") {
            const signal = options?.signal;
            if (!signal) {
              throw new Error("expected close abort signal");
            }
            closeSignals.push(signal);
          }
          return { ok: true };
        },
      );
      const onStatus = vi.fn();
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
        onStatus,
      });
      await session.start();
      const handleTranscript = transportMock.context?.callbacks.onTranscript;
      if (!handleTranscript) {
        throw new Error("expected realtime transcript callback");
      }

      handleTranscript({ role: "user", text: "stalled", final: true });
      for (let index = 0; index < 40; index += 1) {
        handleTranscript({ role: "assistant", text: `queued-${index}`, final: true });
      }
      session.stop();

      expect(transcriptSignals).toHaveLength(1);
      expect(transcriptSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.runAllTimersAsync();

      expect(transcriptSignals[0]?.aborted).toBe(true);
      expect(
        request.mock.calls.filter(([method]) => method === "talk.client.transcript"),
      ).toHaveLength(1);
      expect(request).toHaveBeenCalledWith(
        "talk.client.close",
        {
          sessionKey: "agent:main:main",
          voiceSessionId: "voice-drain-timeout",
        },
        {
          signal: closeSignals[0],
          timeoutMs: 30_000,
        },
      );
      expect(closeSignals[0]).not.toBe(transcriptSignals[0]);
      expect(closeSignals[0]?.aborted).toBe(false);
      expect(onStatus.mock.calls.filter(([status]) => status === "error")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
