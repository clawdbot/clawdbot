// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { RealtimeTalkTransportContext } from "./realtime-talk-shared.ts";

const transports = vi.hoisted(
  () =>
    [] as Array<{
      context: RealtimeTalkTransportContext;
      stop: ReturnType<typeof vi.fn>;
    }>,
);

function transportFixture(context: RealtimeTalkTransportContext) {
  const stop = vi.fn(() => context.input.stop());
  transports.push({ context, stop });
  return { start: async () => "ready" as const, stop };
}

vi.mock("./realtime-talk-webrtc.ts", () => ({
  WebRtcSdpRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    return transportFixture(context);
  }),
}));
vi.mock("./realtime-talk-google-live.ts", () => ({
  GoogleLiveRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    return transportFixture(context);
  }),
}));
vi.mock("./realtime-talk-gateway-relay.ts", () => ({
  GatewayRelayRealtimeTalkTransport: vi.fn(function (
    _session: unknown,
    context: RealtimeTalkTransportContext,
  ) {
    return transportFixture(context);
  }),
}));

import { RealtimeTalkSession } from "./realtime-talk.ts";

function microphone() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

const sessions: RealtimeTalkSession[] = [];
function sessionFor(
  request: ReturnType<typeof vi.fn>,
  transport: "webrtc" | "provider-websocket" | "gateway-relay" = "webrtc",
) {
  const session = new RealtimeTalkSession(
    { request } as never,
    "agent:main:main",
    {},
    { transport },
    { inputDeviceId: "selected-microphone" },
  );
  sessions.push(session);
  return session;
}

function clientSession(transport: "webrtc" | "provider-websocket" | "gateway-relay" = "webrtc") {
  return {
    provider: "fixture",
    transport,
    voiceSessionId: "voice-input",
    relaySessionId: "voice-input",
    clientSecret: "fixture-secret",
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(() => {
  transports.length = 0;
});
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.stop();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Realtime Talk microphone preparation", () => {
  it.each(["webrtc", "provider-websocket", "gateway-relay"] as const)(
    "allocates %s only after permission is granted, even after the activation lifetime",
    async (transport) => {
      vi.useFakeTimers();
      const permission = createDeferred<MediaStream>();
      const media = microphone();
      const getUserMedia = vi.fn(() => permission.promise);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create" && transport === "gateway-relay") {
          throw new Error("Use relay session creation");
        }
        return clientSession(transport);
      });
      const session = sessionFor(request, transport);
      const starting = session.start();
      void starting.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(request).not.toHaveBeenCalled();
      expect(getUserMedia).toHaveBeenCalledOnce();
      permission.resolve(media.stream);
      await starting;
      expect(request.mock.calls.map(([method]) => method)).toEqual(
        transport === "gateway-relay"
          ? ["talk.client.create", "talk.session.create"]
          : ["talk.client.create"],
      );
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(getUserMedia).toHaveBeenCalledWith({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          deviceId: { exact: "selected-microphone" },
        },
      });
      expect(transports[0]?.context.input.stream).toBe(media.stream);
      session.stop();
      expect(media.track.stop).toHaveBeenCalledOnce();
    },
  );

  it("allocates no provider session when microphone permission is denied", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("Denied", "NotAllowedError");
        }),
      },
    });
    const request = vi.fn(async () => clientSession());
    await expect(sessionFor(request).start()).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
  });

  it("cancels pending permission without allocating and releases a late stream", async () => {
    const permission = createDeferred<MediaStream>();
    const media = microphone();
    const getUserMedia = vi.fn(() => permission.promise);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const request = vi.fn(async () => clientSession());
    const session = sessionFor(request);
    const starting = session.start();
    void starting.catch(() => undefined);
    await waitForFast(() => expect(getUserMedia).toHaveBeenCalledOnce());
    session.stop();
    await expect(starting).resolves.toBeUndefined();
    permission.resolve(media.stream);
    await waitForFast(() => expect(media.track.stop).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
  });

  it("releases prepared microphone ownership when provider creation fails", async () => {
    const media = microphone();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => media.stream) } });
    const request = vi.fn(async () => {
      throw new Error("Provider allocation failed");
    });
    await expect(sessionFor(request).start()).rejects.toThrow("Provider allocation failed");
    expect(media.track.stop).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(0);
  });

  it.each([false, true])(
    "rejects microphone loss during allocation without retiring its predecessor (replacement=%s)",
    async (replacement) => {
      const previous = microphone();
      const candidate = microphone();
      const allocation = createDeferred<ReturnType<typeof clientSession>>();
      const getUserMedia = vi
        .fn()
        .mockResolvedValueOnce(replacement ? previous.stream : candidate.stream)
        .mockResolvedValueOnce(candidate.stream);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
      let creates = 0;
      const request = vi.fn(async (method: string) => {
        if (method !== "talk.client.create") {
          return { ok: true };
        }
        creates++;
        return replacement && creates === 1 ? clientSession() : await allocation.promise;
      });
      const session = sessionFor(request);
      if (replacement) {
        await session.start();
      }
      const starting = session.start();
      void starting.catch(() => undefined);
      await waitForFast(() => expect(creates).toBe(replacement ? 2 : 1));
      candidate.track.dispatchEvent(new Event("ended"));
      allocation.resolve(clientSession());
      await expect(starting).rejects.toThrow("Microphone");
      expect(candidate.track.stop).toHaveBeenCalledOnce();
      expect(transports).toHaveLength(replacement ? 1 : 0);
      if (replacement) {
        expect(previous.track.stop).not.toHaveBeenCalled();
        expect(transports[0]?.stop).not.toHaveBeenCalled();
      } else {
        await waitForFast(() =>
          expect(request.mock.calls.some(([method]) => method === "talk.client.close")).toBe(true),
        );
      }
    },
  );
});
