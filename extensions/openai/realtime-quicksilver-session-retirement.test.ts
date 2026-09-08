import { ServerResponse } from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import {
  acquireOpenAIQuicksilverBrowserSessionBroker,
  releaseOpenAIQuicksilverBrowserSessionBroker,
} from "./realtime-quicksilver-session-owner.js";
import {
  createBroker,
  createRequest,
  createResponseHarness,
} from "./realtime-quicksilver.test-helpers.js";

const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const OPAQUE_REALTIME_MODEL = "gpt-live-test-canary";

function requestTarget(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
}

function retirementBridge() {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    isConnected: vi.fn(() => true),
  } satisfies RealtimeVoiceBridge;
}

async function reserveRetirementSession(
  realtime: ReturnType<typeof createBroker>["realtime"],
  createBridge: (params: { onTerminal: () => void }) => RealtimeVoiceBridge,
  ownerConnId?: string,
  gatewayControl: RealtimeVoiceGatewayControl = { bindBridge: vi.fn() },
) {
  const reservation = await realtime.broker.createBrowserSession(
    {
      providerConfig: {},
      model: "gpt-realtime-2.1",
      gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
      gaSideband: { createBridge },
      clientControl: { owner: "gateway" },
      gatewayControl,
      ...(ownerConnId ? { ownerConnId } : {}),
    },
    { type: "api-key", token: "platform-key" },
  );
  if (reservation.transport !== "webrtc") {
    throw new Error("Expected WebRTC reservation");
  }
  return reservation;
}

describe("GA Realtime call retirement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes broker config and logger without replacing its native operations or reservations", async () => {
    const originalHeaders = vi.fn(openAIRealtimeHost.resolveProviderRequestHeaders);
    const replacementHeaders = vi.fn(openAIRealtimeHost.resolveProviderRequestHeaders);
    const originalConfig = vi.fn(() => undefined);
    const nextConfig = vi.fn(() => ({
      gateway: { controlUi: { allowedOrigins: ["https://updated.example"] } },
    }));
    const originalLogger = { debug: vi.fn(), warn: vi.fn() };
    const nextLogger = { debug: vi.fn(), warn: vi.fn() };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        requestTarget(url).endsWith("/hangup")
          ? new Response(null, { status: 204 })
          : new Response("v=answer\r\n", {
              status: 201,
              headers: { Location: "/v1/realtime/calls/rtc_context" },
            }),
      ),
    );
    const first = acquireOpenAIQuicksilverBrowserSessionBroker(
      { getConfig: originalConfig, logger: originalLogger },
      { ...openAIRealtimeHost, resolveProviderRequestHeaders: originalHeaders },
    );
    try {
      const reservation = await reserveRetirementSession(first, retirementBridge);
      const retained = acquireOpenAIQuicksilverBrowserSessionBroker(
        { getConfig: nextConfig, logger: nextLogger },
        { ...openAIRealtimeHost, resolveProviderRequestHeaders: replacementHeaders },
      );
      expect(retained).toBe(first);
      const response = createResponseHarness();
      await retained.handler(
        createRequest({
          token: reservation.clientSecret,
          body: AUDIO_ONLY_SDP,
          origin: "https://updated.example",
        }),
        response.res,
      );
      expect(response.res.statusCode).toBe(201);
      expect(originalConfig).not.toHaveBeenCalled();
      expect(nextConfig).toHaveBeenCalledOnce();
      expect(originalLogger.debug).not.toHaveBeenCalled();
      expect(nextLogger.debug).toHaveBeenCalledOnce();
      expect(originalHeaders).toHaveBeenCalledOnce();
      expect(replacementHeaders).not.toHaveBeenCalled();
      await releaseOpenAIQuicksilverBrowserSessionBroker(retained);
      expect(originalHeaders).toHaveBeenCalledTimes(2);
      expect(replacementHeaders).not.toHaveBeenCalled();
    } finally {
      await releaseOpenAIQuicksilverBrowserSessionBroker(first);
    }
  });

  it.each(["cancel", "cleanup"] as const)(
    "retains a failed GA hangup for a later %s without reviving the client grant",
    async (action) => {
      const bridge = {
        connect: vi.fn(async () => undefined),
        close: vi.fn(),
        sendAudio: vi.fn(),
        setMediaTimestamp: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        isConnected: vi.fn(() => true),
      } satisfies RealtimeVoiceBridge;
      const hangupTargets: string[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const target = requestTarget(url);
        if (target.endsWith("/hangup")) {
          hangupTargets.push(target);
          return new Response(null, { status: hangupTargets.length === 1 ? 503 : 204 });
        }
        return new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/realtime/calls/rtc_retirement" },
        });
      });
      const { realtime } = createBroker({ fetchImpl: fetchMock as typeof fetch });
      try {
        const reservation = await realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: "gpt-realtime-2.1",
            gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
            gaSideband: { createBridge: () => bridge },
            clientControl: { owner: "gateway" },
            gatewayControl: { bindBridge: vi.fn() },
          },
          { type: "api-key", token: "platform-key" },
        );
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }
        const response = createResponseHarness();
        await realtime.handler(
          createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
          response.res,
        );
        expect(response.res.statusCode).toBe(201);
        const close = () =>
          action === "cancel"
            ? realtime.broker.cancelBrowserSession(reservation)
            : realtime.cleanup();
        const firstError = await Promise.resolve(close()).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect.soft(firstError).toBeInstanceOf(Error);
        expect(bridge.close).toHaveBeenCalledOnce();

        const replay = createResponseHarness();
        await realtime.handler(
          createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
          replay.res,
        );
        expect(replay.res.statusCode).toBe(401);

        await close();
        expect
          .soft(hangupTargets)
          .toEqual([
            "https://api.openai.com/v1/realtime/calls/rtc_retirement/hangup",
            "https://api.openai.com/v1/realtime/calls/rtc_retirement/hangup",
          ]);
        await close();
        expect.soft(hangupTargets).toHaveLength(2);
        expect(bridge.close).toHaveBeenCalledOnce();
      } finally {
        await realtime.cleanup();
      }
    },
  );

  it.each([
    "discarded caller",
    "bridge factory failure",
    "bridge connect failure",
    "throwing error callback",
    "terminal during construction",
    "answer delivery failure",
    "answer stream failure",
    "empty answer",
    "shutdown during creation",
    "cancel during creation",
  ])("retries GA retirement after %s without a client retry", async (failure) => {
    vi.useFakeTimers();
    const bridge = retirementBridge();
    let creations = 0;
    let hangups = 0;
    let failHangup = true;
    let releaseCreation!: () => void;
    const creation = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    let releaseFirstHangup!: () => void;
    const firstHangup = new Promise<void>((resolve) => {
      releaseFirstHangup = resolve;
    });
    let cancelSettled = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (requestTarget(url).endsWith("/hangup")) {
        hangups += 1;
        if (failure === "cancel during creation" && hangups === 1) {
          await firstHangup;
        }
        return new Response(null, { status: failHangup && hangups < 3 ? 503 : 204 });
      }
      creations += 1;
      await creation;
      const answer =
        failure === "answer stream failure"
          ? new ReadableStream({
              start(controller) {
                controller.error(new Error("answer read failed"));
              },
            })
          : failure === "empty answer"
            ? ""
            : "v=answer\r\n";
      return new Response(answer, {
        status: 201,
        headers: { Location: "/v1/realtime/calls/rtc_retirement" },
      });
    });
    const { realtime } = createBroker({ fetchImpl: fetchImpl as typeof fetch });
    try {
      const onClose = vi.fn();
      const reservation = await reserveRetirementSession(
        realtime,
        ({ onTerminal }) => {
          if (failure === "bridge factory failure") {
            throw new Error("factory failed");
          }
          if (failure === "terminal during construction") {
            onTerminal();
          }
          if (["bridge connect failure", "throwing error callback"].includes(failure)) {
            vi.mocked(bridge.connect).mockRejectedValue(new Error("connect failed"));
          }
          return bridge;
        },
        undefined,
        failure === "throwing error callback"
          ? {
              bindBridge: vi.fn(),
              onError: () => {
                throw new Error("error callback failed");
              },
              onClose,
            }
          : undefined,
      );
      const response = createResponseHarness();
      if (failure === "answer delivery failure") {
        response.end.mockImplementationOnce(() => {
          queueMicrotask(() => response.res.emit("close"));
        });
      }
      const handling = realtime.handler(
        createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
        response.res,
      );
      await vi.waitFor(() => expect(creations).toBe(1));
      const stopping =
        failure === "shutdown during creation"
          ? realtime.cleanup().catch((error: unknown) => error)
          : failure === "cancel during creation"
            ? Promise.resolve(realtime.broker.cancelBrowserSession(reservation)).then(
                () => {
                  cancelSettled = true;
                  return undefined;
                },
                (error: unknown) => {
                  cancelSettled = true;
                  return error;
                },
              )
            : undefined;
      releaseCreation();
      if (failure === "cancel during creation") {
        await vi.waitFor(() => expect(hangups).toBe(1));
        expect.soft(cancelSettled).toBe(false);
        releaseFirstHangup();
      }
      const handlingError = await handling.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect.soft(handlingError).toBeUndefined();
      if (failure === "throwing error callback") {
        expect.soft(onClose).toHaveBeenCalledOnce();
      }
      if (failure === "discarded caller") {
        await expect(realtime.broker.cancelBrowserSession(reservation)).rejects.toThrow();
      }
      expect(hangups).toBe(1);
      if (stopping) {
        const stopError = await stopping;
        if (failure === "cancel during creation") {
          expect(response.res.statusCode).toBe(502);
          expect(stopError).toMatchObject({ message: "OpenAI Realtime call hangup failed (503)" });
        } else {
          expect(stopError).toBeInstanceOf(Error);
        }
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(hangups).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(hangups).toBe(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(hangups).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(hangups).toBe(3);
      expect(creations).toBe(1);
      expect(bridge.close).toHaveBeenCalledTimes(
        [
          "bridge factory failure",
          "shutdown during creation",
          "cancel during creation",
          "answer stream failure",
          "empty answer",
        ].includes(failure)
          ? 0
          : 1,
      );
      const replay = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
        replay.res,
      );
      expect(replay.res.statusCode).toBe(401);
      await realtime.cleanup();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(hangups).toBe(3);
    } finally {
      failHangup = false;
      releaseCreation();
      releaseFirstHangup();
      await realtime.cleanup();
    }
  });

  it.each(["finish", "close"] as const)(
    "joins the first failed retirement when delayed answer delivery emits %s",
    async (deliveryEvent) => {
      vi.useFakeTimers();
      const bridge = retirementBridge();
      let hangups = 0;
      let failHangup = true;
      let answerStarted!: () => void;
      const delivering = new Promise<void>((resolve) => {
        answerStarted = resolve;
      });
      const fetchImpl = vi.fn(async (url: string | URL | Request) => {
        if (requestTarget(url).endsWith("/hangup")) {
          hangups += 1;
          return new Response(null, { status: failHangup ? 503 : 204 });
        }
        return new Response("v=answer\r\n", {
          status: 201,
          headers: { Location: "/v1/realtime/calls/rtc_retirement" },
        });
      });
      const { realtime, logger } = createBroker({ fetchImpl: fetchImpl as typeof fetch });
      const request = createRequest({ body: AUDIO_ONLY_SDP });
      const response = new ServerResponse(request);
      const end = vi.spyOn(response, "end").mockImplementationOnce(() => {
        response.writeHead(response.statusCode);
        answerStarted();
        return response;
      });
      let handling: Promise<boolean> | undefined;
      try {
        const reservation = await reserveRetirementSession(realtime, () => bridge);
        request.headers.authorization = `Bearer ${reservation.clientSecret}`;
        handling = realtime.handler(request, response);
        await delivering;
        expect(response.headersSent).toBe(true);
        await expect(realtime.broker.cancelBrowserSession(reservation)).rejects.toThrow(
          "OpenAI Realtime call hangup failed (503)",
        );
        expect(hangups).toBe(1);
        response.emit(deliveryEvent);
        await expect(handling).resolves.toBe(true);
        expect(end).toHaveBeenCalledOnce();
        expect.soft(hangups).toBe(1);
        await vi.advanceTimersByTimeAsync(999);
        expect.soft(hangups).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect.soft(hangups).toBe(2);
        await vi.advanceTimersByTimeAsync(4_999);
        expect.soft(hangups).toBe(2);
        await vi.advanceTimersByTimeAsync(1);
        expect.soft(hangups).toBe(3);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect.soft(hangups).toBe(3);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("INCOMPLETE"));
        expect(bridge.close).toHaveBeenCalledOnce();
      } finally {
        failHangup = false;
        response.emit(deliveryEvent);
        await handling?.catch(() => undefined);
        await realtime.cleanup();
      }
    },
  );

  it.each([204, 404])("coalesces reentrant retirement and settles HTTP %s once", async (status) => {
    vi.useFakeTimers();
    const bridge = retirementBridge();
    let finishHangup!: () => void;
    const hungUp = new Promise<void>((resolve) => {
      finishHangup = resolve;
    });
    let hangups = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (requestTarget(url).endsWith("/hangup")) {
        hangups += 1;
        await hungUp;
        return new Response(null, { status });
      }
      return new Response("v=answer\r\n", {
        status: 201,
        headers: { Location: "/v1/realtime/calls/rtc_retirement" },
      });
    });
    const { realtime } = createBroker({ fetchImpl: fetchImpl as typeof fetch });
    let reentered: Promise<void> | undefined;
    try {
      const reservation = await reserveRetirementSession(realtime, ({ onTerminal }) => {
        vi.mocked(bridge.close).mockImplementation(() => {
          onTerminal();
          reentered = Promise.resolve(realtime.broker.cancelBrowserSession(reservation));
        });
        return bridge;
      });
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
        createResponseHarness().res,
      );
      const first = realtime.broker.cancelBrowserSession(reservation);
      const concurrent = realtime.cleanup();
      expect(hangups).toBe(1);
      expect(bridge.close).toHaveBeenCalledOnce();
      finishHangup();
      await Promise.all([first, concurrent, reentered]);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await realtime.cleanup();
      expect(hangups).toBe(1);
    } finally {
      finishHangup();
      await realtime.cleanup();
    }
  });

  it.each([
    { scope: "global", count: 8, ownerConnId: undefined, nativeReplacement: false },
    { scope: "per-client", count: 2, ownerConnId: "conn-retiring", nativeReplacement: false },
    { scope: "per-client native", count: 2, ownerConnId: "conn-retiring", nativeReplacement: true },
  ])(
    "retains exhausted old broker calls and $scope capacity across replacement",
    async ({ count, ownerConnId, nativeReplacement }) => {
      vi.useFakeTimers();
      let failHangup = true;
      let hangups = 0;
      let callId = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request) => {
          if (requestTarget(url).endsWith("/hangup")) {
            hangups += 1;
            return new Response(null, { status: failHangup ? 503 : 204 });
          }
          callId += 1;
          return new Response("v=answer\r\n", {
            status: 201,
            headers: { Location: `/v1/realtime/calls/rtc_retirement_${callId}` },
          });
        }),
      );
      const params = { getConfig: () => undefined, logger: { debug: vi.fn(), warn: vi.fn() } };
      const old = acquireOpenAIQuicksilverBrowserSessionBroker(params, openAIRealtimeHost);
      let replacement: typeof old | undefined;
      const reserveNext = (current: typeof old, clientOwner = ownerConnId) =>
        nativeReplacement
          ? current.broker.createBrowserSession(
              {
                providerConfig: {},
                model: OPAQUE_REALTIME_MODEL,
                ownerConnId: clientOwner,
                runAgentConsult: vi.fn(async () => ({ text: "Done" })),
                clientControl: { owner: "gateway" },
                gatewayControl: { bindBridge: vi.fn(), bindControl: vi.fn() },
              },
              { type: "api-key", token: "platform-key" },
            )
          : reserveRetirementSession(current, () => retirementBridge(), clientOwner);
      try {
        for (let index = 0; index < count; index += 1) {
          const reservation = await reserveRetirementSession(
            old,
            () => retirementBridge(),
            ownerConnId,
          );
          await old.handler(
            createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
            createResponseHarness().res,
          );
        }
        await expect(releaseOpenAIQuicksilverBrowserSessionBroker(old)).rejects.toThrow();
        replacement = acquireOpenAIQuicksilverBrowserSessionBroker(params, openAIRealtimeHost);
        expect(replacement).not.toBe(old);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(hangups).toBe(count * 3);
        expect(params.logger.warn).toHaveBeenCalledWith(expect.stringContaining("INCOMPLETE"));
        await expect(reserveNext(replacement)).rejects.toThrow("Too many concurrent");
        if (nativeReplacement) {
          await expect(reserveNext(replacement, "conn-other")).resolves.toMatchObject({
            transport: "webrtc",
          });
        }
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(hangups).toBe(count * 3);
        const disabledReplacement = replacement;
        await expect(
          releaseOpenAIQuicksilverBrowserSessionBroker(disabledReplacement),
        ).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(6_000);
        expect(hangups).toBe(count * 6);
        replacement = acquireOpenAIQuicksilverBrowserSessionBroker(params, openAIRealtimeHost);
        expect(replacement).not.toBe(disabledReplacement);
        failHangup = false;
        await releaseOpenAIQuicksilverBrowserSessionBroker(disabledReplacement);
        expect(hangups).toBe(count * 7);
        expect(acquireOpenAIQuicksilverBrowserSessionBroker(params, openAIRealtimeHost)).toBe(
          replacement,
        );
        await expect(reserveNext(replacement)).resolves.toMatchObject({ transport: "webrtc" });
        await releaseOpenAIQuicksilverBrowserSessionBroker(old);
        expect(acquireOpenAIQuicksilverBrowserSessionBroker(params, openAIRealtimeHost)).toBe(
          replacement,
        );
      } finally {
        failHangup = false;
        await releaseOpenAIQuicksilverBrowserSessionBroker(old);
        if (replacement) {
          await releaseOpenAIQuicksilverBrowserSessionBroker(replacement);
        }
      }
    },
  );
});
