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
          ? ["talk.catalog", "talk.client.create", "talk.session.create"]
          : ["talk.catalog", "talk.client.create"],
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

  it("stops a reentrant preparing status before microphone or catalog admission", async () => {
    const getUserMedia = vi.fn(async () => microphone().stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const request = vi.fn(async () => clientSession());
    const session = new RealtimeTalkSession(
      { request } as never,
      "agent:main:main",
      {
        onStatus: (status) => {
          if (status === "connecting") {
            session.stop();
          }
        },
      },
      { transport: "webrtc" },
    );
    sessions.push(session);
    await session.start();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
  });

  it.each(["stop", "ended"] as const)(
    "owns prepared input during catalog lookup: %s",
    async (outcome) => {
      const media = microphone();
      const catalog = createDeferred<Record<string, unknown>>();
      const getUserMedia = vi.fn(async () => media.stream);
      vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
      const request = vi.fn(async (method: string) =>
        method === "talk.catalog" ? await catalog.promise : clientSession(),
      );
      const session = sessionFor(request);
      const starting = session.start();
      void starting.catch(() => undefined);
      try {
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith("talk.catalog", {}, expect.anything()),
        );
        expect(getUserMedia).toHaveBeenCalledOnce();
        if (outcome === "stop") {
          session.stop();
        } else {
          media.track.dispatchEvent(new Event("ended"));
        }
        catalog.resolve({});
        if (outcome === "stop") {
          await expect(starting).resolves.toBeUndefined();
        } else {
          await expect(starting).rejects.toThrow("Microphone");
        }
        expect(request.mock.calls.map(([method]) => method)).toEqual(["talk.catalog"]);
        expect(media.track.stop).toHaveBeenCalledOnce();
        expect(transports).toHaveLength(0);
      } finally {
        session.stop();
        catalog.resolve({});
        await starting.catch(() => undefined);
      }
    },
  );

  it.each([
    ["client", "stop"],
    ["client", "ended"],
    ["config", "stop"],
    ["config", "ended"],
  ] as const)(
    "never recovers an invalidated Auto allocation during %s: %s",
    async (phase, outcome) => {
      const media = microphone();
      const allocation = createDeferred<ReturnType<typeof clientSession>>();
      const config = createDeferred<Record<string, unknown>>();
      const failure = new Error("Client allocation failed");
      void allocation.promise.catch(() => undefined);
      vi.stubGlobal("navigator", {
        mediaDevices: { getUserMedia: vi.fn(async () => media.stream) },
      });
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.create") {
          if (phase === "client") {
            return await allocation.promise;
          }
          throw failure;
        }
        if (method === "talk.config") {
          return phase === "config" ? await config.promise : { config: {} };
        }
        return clientSession("gateway-relay");
      });
      const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
      sessions.push(session);
      const starting = session.start();
      void starting.catch(() => undefined);
      try {
        await waitForFast(() =>
          expect(request).toHaveBeenCalledWith(
            phase === "client" ? "talk.client.create" : "talk.config",
            expect.anything(),
            expect.anything(),
          ),
        );
        if (outcome === "stop") {
          session.stop();
        } else {
          media.track.dispatchEvent(new Event("ended"));
        }
        allocation.reject(failure);
        config.resolve({ config: {} });
        await expect(starting).rejects.toThrow(failure);
        expect(request.mock.calls.map(([method]) => method)).toEqual(
          phase === "client"
            ? ["talk.catalog", "talk.client.create"]
            : ["talk.catalog", "talk.client.create", "talk.config"],
        );
        expect(media.track.stop).toHaveBeenCalledOnce();
        expect(transports).toHaveLength(0);
      } finally {
        session.stop();
        allocation.reject(failure);
        config.resolve({ config: {} });
        await starting.catch(() => undefined);
      }
    },
  );

  it("never recovers a replaced Auto allocation into the new call", async () => {
    const previous = microphone();
    const replacement = microphone();
    const allocation = createDeferred<ReturnType<typeof clientSession>>();
    const failure = new Error("Replaced client allocation failed");
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(previous.stream)
      .mockResolvedValueOnce(replacement.stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    let creates = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create") {
        creates += 1;
        return creates === 1 ? await allocation.promise : clientSession();
      }
      if (method === "talk.config") {
        return { config: {} };
      }
      return clientSession("gateway-relay");
    });
    const session = new RealtimeTalkSession({ request } as never, "agent:main:main");
    sessions.push(session);
    const starting = session.start();
    void starting.catch(() => undefined);
    try {
      await waitForFast(() => expect(creates).toBe(1));
      await session.start();
      allocation.reject(failure);
      await expect(starting).rejects.toThrow(failure);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "talk.catalog",
        "talk.client.create",
        "talk.catalog",
        "talk.client.create",
      ]);
      expect(previous.track.stop).toHaveBeenCalledOnce();
      expect(replacement.track.stop).not.toHaveBeenCalled();
      expect(transports).toHaveLength(1);
      expect(transports[0]?.context.input.stream).toBe(replacement.stream);
    } finally {
      session.stop();
      allocation.reject(failure);
      await starting.catch(() => undefined);
    }
    expect(replacement.track.stop).toHaveBeenCalledOnce();
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
    "rejects microphone loss during allocation after retiring any previous call (replacement=%s)",
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
      allocation.resolve({ ...clientSession(), voiceSessionId: "voice-input-candidate" });
      await expect(starting).rejects.toThrow("Microphone");
      expect(candidate.track.stop).toHaveBeenCalledOnce();
      expect(transports).toHaveLength(replacement ? 1 : 0);
      if (replacement) {
        expect(previous.track.stop).toHaveBeenCalledOnce();
        expect(transports[0]?.stop).toHaveBeenCalledOnce();
      }
      await waitForFast(() =>
        expect(
          request.mock.calls.filter(([method]) => method === "talk.client.close"),
        ).toHaveLength(replacement ? 2 : 1),
      );
    },
  );
});
