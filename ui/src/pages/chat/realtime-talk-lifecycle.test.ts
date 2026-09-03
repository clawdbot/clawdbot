// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useRealtimeTalkMicrophoneFixture } from "./realtime-talk-input.test-support.ts";
import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

const transportMock = vi.hoisted(() => ({
  relayContexts: [] as RealtimeTalkTransportContext[],
  relayStops: [] as Array<ReturnType<typeof vi.fn>>,
  webRtcContexts: [] as RealtimeTalkTransportContext[],
  webRtcStops: [] as Array<ReturnType<typeof vi.fn>>,
  relayActivate: vi.fn(),
  start: vi.fn(async (): Promise<"ready" | "cancelled"> => "ready"),
  stop: vi.fn(),
}));

vi.mock("./realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.relayContexts.push(context);
    const stop = vi.fn((options?: { emitClosed?: boolean }) => transportMock.stop(options));
    transportMock.relayStops.push(stop);
    return {
      start: transportMock.start,
      activate: transportMock.relayActivate,
      stop,
    };
  }),
}));
vi.mock("./realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: vi.fn(),
}));
vi.mock("./realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    transportMock.webRtcContexts.push(context);
    const stop = vi.fn((options?: { emitClosed?: boolean }) => transportMock.stop(options));
    transportMock.webRtcStops.push(stop);
    return { start: transportMock.start, stop };
  }),
}));

import { RealtimeTalkSession } from "./realtime-talk.ts";

const requestTimeoutOptions = { timeoutMs: 30_000 };

type TranscriptContext = RealtimeTalkTransportContext & {
  callbacks: {
    onTranscript?: (entry: { role: "user" | "assistant"; text: string; final: boolean }) => void;
  };
  flushTranscriptWrites?: () => Promise<void>;
};

function transcriptContext(contexts: RealtimeTalkTransportContext[], index = 0): TranscriptContext {
  const context = contexts[index];
  if (!context) {
    throw new Error("expected realtime transport context");
  }
  return context as TranscriptContext;
}

useRealtimeTalkMicrophoneFixture();

describe("RealtimeTalkSession lifecycle", () => {
  beforeEach(() => {
    transportMock.relayContexts.length = 0;
    transportMock.relayStops.length = 0;
    transportMock.webRtcContexts.length = 0;
    transportMock.webRtcStops.length = 0;
    transportMock.relayActivate.mockClear();
    transportMock.start.mockClear();
    transportMock.stop.mockClear();
  });

  it("retires a restarted call before allocation and drains its accepted transcript after startup fails", async () => {
    const saved = createDeferred();
    let creates = 0;
    let oldStopsAtAllocation = 0;
    const request = vi.fn(async (method: string, params?: { voiceSessionId?: string }) => {
      if (method === "talk.client.create") {
        creates += 1;
        if (creates === 2) {
          oldStopsAtAllocation = transportMock.webRtcStops[0]!.mock.calls.length;
        }
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: params?.voiceSessionId ?? `voice-restart-${creates}`,
          clientSecret: "fixture-secret",
        };
      }
      if (method === "talk.client.transcript") {
        await saved.promise;
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    try {
      await session.start();
      const previous = transcriptContext(transportMock.webRtcContexts);
      previous.callbacks.onTranscript?.({
        role: "user",
        text: "accepted before restart",
        final: true,
      });
      transportMock.start.mockRejectedValueOnce(new Error("replacement startup failed"));

      await expect(session.start()).rejects.toThrow("replacement startup failed");

      expect(oldStopsAtAllocation).toBe(1);
      expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
      expect(transportMock.webRtcStops[1]).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(
          request.mock.calls
            .filter(([method]) => method === "talk.client.close")
            .map(([, params]) => params?.voiceSessionId),
        ).toEqual(["voice-restart-2"]),
      );
      previous.callbacks.onTranscript?.({ role: "user", text: "stale after restart", final: true });
      saved.resolve();
      await vi.waitFor(() =>
        expect(
          request.mock.calls
            .filter(([method]) => method === "talk.client.close")
            .map(([, params]) => params?.voiceSessionId),
        ).toEqual(["voice-restart-2", "voice-restart-1"]),
      );
      expect(
        request.mock.calls.filter(([method]) => method === "talk.client.transcript"),
      ).toHaveLength(1);
    } finally {
      saved.resolve();
      session.stop();
    }
  });

  it("retries finalized transcript writes in order", async () => {
    vi.useFakeTimers();
    try {
      const transcriptEntryIds: string[] = [];
      let firstAttempt = true;
      const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-queue",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.transcript") {
          transcriptEntryIds.push(String(params?.entryId));
          if (params?.entryId === "1" && firstAttempt) {
            firstAttempt = false;
            throw new Error("temporary failure");
          }
          return { ok: true };
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      await session.start();
      const context = transcriptContext(transportMock.webRtcContexts);
      context.callbacks.onTranscript?.({ role: "user", text: "first", final: true });
      context.callbacks.onTranscript?.({ role: "assistant", text: "second", final: true });

      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => expect(transcriptEntryIds).toEqual(["1", "1", "2"]));
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts fresh transcript ownership when restarting the same browser session", async () => {
    let creates = 0;
    const entries: Array<{ voiceSessionId?: string; entryId?: string }> = [];
    const request = vi.fn(
      async (method: string, params?: { voiceSessionId?: string; entryId?: string }) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: `voice-restart-${++creates}`,
            clientSecret: "fixture-secret",
          };
        }
        if (method === "talk.client.transcript") {
          entries.push({ voiceSessionId: params?.voiceSessionId, entryId: params?.entryId });
        }
        return { ok: true };
      },
    );
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const first = transcriptContext(transportMock.webRtcContexts);
    first.callbacks.onTranscript?.({ role: "user", text: "first call", final: true });
    await first.flushTranscriptWrites?.();
    await session.start();
    const second = transcriptContext(transportMock.webRtcContexts, 1);
    second.callbacks.onTranscript?.({ role: "assistant", text: "second call", final: true });
    await second.flushTranscriptWrites?.();
    expect(entries).toEqual([
      { voiceSessionId: "voice-restart-1", entryId: "1" },
      { voiceSessionId: "voice-restart-2", entryId: "1" },
    ]);
    for (const [, params] of request.mock.calls.filter(
      ([method]) => method === "talk.client.create",
    )) {
      expect(params).not.toHaveProperty("voiceSessionId");
    }
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[1]).not.toHaveBeenCalled();
    session.stop();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        2,
      ),
    );
  });

  it("closes both calls when a restart cancels during transport startup", async () => {
    let creates = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-cancelled-${++creates}`,
          clientSecret: "fixture-secret",
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const previous = transcriptContext(transportMock.webRtcContexts);
    transportMock.start.mockResolvedValueOnce("cancelled");
    await session.start();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    previous.callbacks.onTranscript?.({ role: "user", text: "stale call", final: true });
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        2,
      ),
    );
    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
    session.stop();
  });

  it("retires both relays when restart activation throws", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-activation",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    transportMock.relayActivate.mockImplementationOnce(() => {
      throw new Error("activation failed");
    });

    await expect(session.start()).rejects.toThrow("activation failed");

    expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.relayStops[1]).toHaveBeenCalledOnce();
    session.stop();
    expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
  });

  it("does not restore an active relay after activation stops the session", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-activation-stop",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    transportMock.relayActivate.mockImplementationOnce(() => {
      session.stop();
      throw new Error("activation stopped");
    });

    await expect(session.start()).rejects.toThrow("activation stopped");

    expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.relayStops[0]).toHaveBeenCalledWith();
    expect(transportMock.relayStops[1]).toHaveBeenCalledOnce();
    session.stop();
    expect(transportMock.relayStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.relayStops[1]).toHaveBeenCalledOnce();
  });

  it("ignores transcripts from a superseded pending replacement", async () => {
    const firstReplacementStart = createDeferred<"ready">();
    const transcriptEntryIds: string[] = [];
    let creates = 0;
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-overlapping-${++creates}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        transcriptEntryIds.push(String(params?.entryId));
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    transportMock.start.mockImplementationOnce(async () => await firstReplacementStart.promise);

    const firstReplacement = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(2));
    await session.start();

    const supersededContext = transcriptContext(transportMock.webRtcContexts, 1);
    const activeContext = transcriptContext(transportMock.webRtcContexts, 2);
    supersededContext.callbacks.onTranscript?.({ role: "user", text: "stale", final: true });
    activeContext.callbacks.onTranscript?.({ role: "user", text: "active", final: true });
    await activeContext.flushTranscriptWrites?.();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });

    firstReplacementStart.resolve("ready");
    await firstReplacement;
    session.stop();
  });

  it("does not supersede an admitted restart when its predecessor is still draining", async () => {
    const replacementCreate = createDeferred<{
      provider: string;
      transport: "webrtc";
      voiceSessionId: string;
      clientSecret: string;
    }>();
    const predecessorClose = createDeferred();
    let creates = 0;
    const transcriptEntryIds: string[] = [];
    const request = vi.fn(
      async (method: string, params?: { voiceSessionId?: string; entryId?: string }) => {
        if (method === "talk.client.create") {
          if (++creates === 2) {
            return await replacementCreate.promise;
          }
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-admission-1",
            clientSecret: "fixture-secret",
          };
        }
        if (method === "talk.client.close" && params?.voiceSessionId === "voice-admission-1") {
          await predecessorClose.promise;
        }
        if (method === "talk.client.transcript") {
          transcriptEntryIds.push(String(params?.entryId));
        }
        return { ok: true };
      },
    );
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    let replacement: Promise<void> | undefined;
    try {
      await session.start();
      replacement = session.start();
      await vi.waitFor(() => expect(creates).toBe(2));
      await expect(session.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(creates).toBe(2);
      replacementCreate.resolve({
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: "voice-admission-2",
        clientSecret: "fixture-secret",
      });
      await replacement;
      expect(transportMock.webRtcContexts).toHaveLength(2);
      expect(transportMock.webRtcStops[1]).not.toHaveBeenCalled();
      const active = transcriptContext(transportMock.webRtcContexts, 1);
      active.callbacks.onTranscript?.({ role: "user", text: "still active", final: true });
      await active.flushTranscriptWrites?.();
      expect(transcriptEntryIds).toEqual(["1"]);
    } finally {
      predecessorClose.resolve();
      replacementCreate.resolve({
        provider: "openai",
        transport: "webrtc",
        voiceSessionId: "voice-admission-2",
        clientSecret: "fixture-secret",
      });
      session.stop();
      await replacement;
    }
  });

  it("releases newly allocated owners after transport startup failures", async () => {
    let createCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-start-${createCount}`,
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const client = { request } as never;
    transportMock.start
      .mockRejectedValueOnce(new Error("first startup failed"))
      .mockRejectedValueOnce(new Error("second startup failed"));

    const first = new RealtimeTalkSession(client, "agent:main:main");
    await expect(first.start()).rejects.toThrow("first startup failed");
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        1,
      ),
    );

    const second = new RealtimeTalkSession(client, "agent:main:main");
    await expect(second.start()).rejects.toThrow("second startup failed");
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        2,
      ),
    );

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    recovered.stop();
  });

  it("rejects a terminal failure during initial transport setup", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-terminal-startup",
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const onStatus = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onStatus,
    });
    transportMock.start.mockRejectedValueOnce(new Error("Realtime connection closed"));

    await expect(session.start()).rejects.toThrow("Realtime connection closed");

    expect(onStatus).toHaveBeenCalledWith("connecting", "Preparing voice session...");
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith({ emitClosed: false });
  });

  it("does not restore a failed replacement after concurrent stop", async () => {
    const replacementStart = createDeferred<"ready">();
    const transcriptEntryIds: string[] = [];
    let creates = 0;
    const request = vi.fn(async (method: string, params?: { entryId?: string }) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-concurrent-stop-${++creates}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.transcript") {
        transcriptEntryIds.push(String(params?.entryId));
      }
      return { ok: true };
    });
    const client = { request } as never;
    const session = new RealtimeTalkSession(client, "agent:main:main");
    await session.start();
    const existingContext = transcriptContext(transportMock.webRtcContexts);
    transportMock.start.mockImplementationOnce(async () => await replacementStart.promise);

    existingContext.callbacks.onTranscript?.({ role: "user", text: "before restart", final: true });
    await existingContext.flushTranscriptWrites?.();
    const replacing = session.start();
    await vi.waitFor(() => expect(transportMock.webRtcContexts).toHaveLength(2));
    existingContext.callbacks.onTranscript?.({ role: "user", text: "during restart", final: true });
    expect(transcriptEntryIds).toEqual(["1"]);

    session.stop();
    replacementStart.reject(new Error("replacement failed after stop"));
    await expect(replacing).rejects.toThrow("replacement failed after stop");

    existingContext.callbacks.onTranscript?.({ role: "user", text: "too late", final: true });
    await Promise.resolve();
    expect(transcriptEntryIds).toEqual(["1"]);
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledOnce();
    expect(transportMock.webRtcStops[0]).toHaveBeenCalledWith();
    expect(transportMock.webRtcStops[1]).toHaveBeenCalledWith({ emitClosed: false });
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(
        2,
      ),
    );

    const recovered = new RealtimeTalkSession(client, "agent:main:main");
    await recovered.start();
    recovered.stop();
  });

  it("surfaces transcript failure after three attempts", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-failure",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.transcript") {
          throw new Error("still unavailable");
        }
        return { ok: true };
      });
      const onStatus = vi.fn();
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
        onStatus,
      });
      await session.start();
      const context = transcriptContext(transportMock.webRtcContexts);
      context.callbacks.onTranscript?.({ role: "user", text: "save me", final: true });

      await vi.advanceTimersByTimeAsync(2_500);
      await vi.waitFor(() =>
        expect(onStatus).toHaveBeenCalledWith(
          "error",
          expect.stringContaining("Voice transcript could not be saved"),
        ),
      );
      expect(
        request.mock.calls.filter(([method]) => method === "talk.client.transcript"),
      ).toHaveLength(3);
      expect(warn).toHaveBeenCalled();
      session.stop();
      await vi.runAllTimersAsync();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries logical voice-session close after transient failures", async () => {
    vi.useFakeTimers();
    try {
      let closeAttempts = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          return {
            provider: "openai",
            transport: "webrtc",
            voiceSessionId: "voice-close-retry",
            clientSecret: "secret",
          };
        }
        if (method === "talk.client.close" && ++closeAttempts < 3) {
          throw new Error("temporary close failure");
        }
        return { ok: true };
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      await session.start();

      session.stop();
      await vi.runAllTimersAsync();

      expect(closeAttempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a new call without resuming the voice session being closed", async () => {
    let createCount = 0;
    let finishClose: (() => void) | undefined;
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.close") {
        await closing;
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();

    await session.start();

    const creates = request.mock.calls.filter(([method]) => method === "talk.client.create");
    expect(creates).toEqual([
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
      [
        "talk.client.create",
        { sessionKey: "agent:main:main", capabilities: ["voice-transcript"] },
        requestTimeoutOptions,
      ],
    ]);
    finishClose?.();
    session.stop();
    await Promise.resolve();
  });

  it("bounds active and draining client voice owners across session objects", async () => {
    let createCount = 0;
    const closes: Array<ReturnType<typeof createDeferred<void>>> = [];
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      if (method === "talk.client.close") {
        const close = createDeferred();
        closes.push(close);
        await close.promise;
      }
      return { ok: true };
    });
    const client = { request } as never;
    const first = new RealtimeTalkSession(client, "agent:main:main");
    const second = new RealtimeTalkSession(client, "agent:main:main");
    const third = new RealtimeTalkSession(client, "agent:main:main");

    await first.start();
    await second.start();
    await expect(first.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(transportMock.webRtcStops[0]).not.toHaveBeenCalled();
    expect(transportMock.webRtcStops[1]).not.toHaveBeenCalled();
    expect(createCount).toBe(2);
    first.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    second.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(2));

    await expect(third.start()).rejects.toThrow(
      "Too many active or closing realtime Talk voice sessions",
    );
    expect(createCount).toBe(2);

    closes[0]?.resolve();
    await vi.waitFor(async () => {
      await third.start();
      expect(createCount).toBe(3);
    });

    third.stop();
    await vi.waitFor(() => expect(closes).toHaveLength(3));
    closes[1]?.resolve();
    closes[2]?.resolve();
  });

  it("bounds stalled detached owners across browser session keys", async () => {
    vi.useFakeTimers();
    try {
      let createCount = 0;
      const closeSignals: AbortSignal[] = [];
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
          if (method === "talk.client.create") {
            createCount += 1;
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: `voice-${createCount}`,
              clientSecret: "secret",
            };
          }
          if (method === "talk.client.close") {
            const signal = options?.signal;
            if (!signal) {
              throw new Error("expected close abort signal");
            }
            closeSignals.push(signal);
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          return { ok: true };
        },
      );
      const client = { request } as never;
      const draining = Array.from(
        { length: 16 },
        (_, index) => new RealtimeTalkSession(client, `agent:main:session-${index}`),
      );

      for (const session of draining) {
        await session.start();
        session.stop();
        await Promise.resolve();
      }
      expect(closeSignals).toHaveLength(16);

      const recovered = new RealtimeTalkSession(client, "agent:main:session-recovered");
      await expect(recovered.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(createCount).toBe(16);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(closeSignals.every((signal) => !signal.aborted)).toBe(true);
      await expect(recovered.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(closeSignals.every((signal) => signal.aborted)).toBe(true);

      await recovered.start();
      expect(createCount).toBe(17);
      recovered.stop();
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases bounded startup owners after request deadlines", async () => {
    vi.useFakeTimers();
    let failCreate = true;
    try {
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
          if (method !== "talk.client.create") {
            return { ok: true };
          }
          if (!failCreate) {
            return {
              provider: "openai",
              transport: "webrtc",
              voiceSessionId: "voice-recovered",
              clientSecret: "secret",
            };
          }
          await new Promise<void>((_resolve, reject) => {
            setTimeout(() => reject(new Error("request timeout")), options?.timeoutMs);
          });
          return { ok: true };
        },
      );
      const client = { request } as never;
      const first = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });
      const second = new RealtimeTalkSession(
        client,
        "agent:main:main",
        {},
        { transport: "webrtc" },
      );
      const third = new RealtimeTalkSession(client, "agent:main:main", {}, { transport: "webrtc" });

      const startsSettled = Promise.allSettled([first.start(), second.start()]);
      await Promise.resolve();
      await Promise.resolve();
      await expect(third.start()).rejects.toThrow(
        "Too many active or closing realtime Talk voice sessions",
      );
      expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toHaveLength(
        2,
      );

      await vi.advanceTimersByTimeAsync(30_000);
      const settled = await startsSettled;
      expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);

      failCreate = false;
      await third.start();
      third.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores final transcript callbacks emitted after shutdown begins", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: "voice-shutdown",
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const context = transcriptContext(transportMock.webRtcContexts);

    session.stop();
    context.callbacks.onTranscript?.({ role: "user", text: "too late", final: true });
    await Promise.resolve();

    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
  });

  it("drops a previous transport's delayed transcript after stop and restart", async () => {
    let createCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        createCount += 1;
        return {
          provider: "openai",
          transport: "webrtc",
          voiceSessionId: `voice-${createCount}`,
          clientSecret: "secret",
        };
      }
      return { ok: true };
    });
    const onTranscript = vi.fn();
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main", {
      onTranscript,
    });
    await session.start();
    const previousContext = transcriptContext(transportMock.webRtcContexts);

    session.stop();
    await session.start();
    previousContext.callbacks.onTranscript?.({
      role: "user",
      text: "stale transcript",
      final: true,
    });
    await Promise.resolve();

    expect(onTranscript).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
  });

  it("does not report Gateway relay transcripts through the client RPC", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        return {
          provider: "openai",
          transport: "gateway-relay",
          relaySessionId: "relay-voice",
          audio: {
            inputEncoding: "pcm16",
            inputSampleRateHz: 24_000,
            outputEncoding: "pcm16",
            outputSampleRateHz: 24_000,
          },
        };
      }
      return { ok: true };
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    await session.start();
    const context = transcriptContext(transportMock.relayContexts);
    expect(transportMock.relayActivate).toHaveBeenCalledOnce();
    context.callbacks.onTranscript?.({ role: "user", text: "server owns this", final: true });
    await Promise.resolve();

    expect(request.mock.calls.some(([method]) => method === "talk.client.transcript")).toBe(false);
    session.stop();
    await Promise.resolve();
    expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(false);
  });
});
