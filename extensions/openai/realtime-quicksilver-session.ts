// Native GPT-Live browser sessions: WebRTC offer broker plus gateway-owned sideband control.
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceProviderCapabilities,
} from "openclaw/plugin-sdk/realtime-voice";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import WebSocket, { type RawData } from "ws";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import {
  applyRealtimeOfferCorsHeaders,
  createResponseDeliveryWaiter,
  readOfferBearerToken,
  rejectOversizedOffer,
  respondRealtimeOffer,
} from "./realtime-quicksilver-offer-http.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
  hangupOpenAIRealtimeCall,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInitialItem,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";
import {
  OPENAI_QUICKSILVER_CAPABILITIES,
  isOpenAIGptLiveModel,
  resolveOpenAIQuicksilverVoice,
} from "./realtime-quicksilver.js";
import { assertOpenAIRealtimeAudioOnlyOffer } from "./realtime-sdp-offer.js";
import {
  createOpenAIRealtimeSessionLease,
  type OpenAIRealtimeSession,
} from "./realtime-session-retirement.js";
export const OPENAI_QUICKSILVER_OFFER_PATH = "/plugins/openai/realtime/calls";

const OPENAI_QUICKSILVER_PENDING_TTL_MS = 60_000;
const OPENAI_QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const OPENAI_QUICKSILVER_MAX_SDP_BYTES = 256 * 1024;
const OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverSessionRequest = {
  initialItems?: OpenAIQuicksilverInitialItem[];
  ownerConnId?: string;
} & (
  | (RealtimeVoiceBrowserSessionCreateRequest & {
      gaSession?: Record<string, unknown> & { model: string };
      gaSideband?: never;
    })
  // Stable GA hosts bind a full bridge. Keep that broker-only mode separate
  // from the public negotiated request, which requires command binding.
  | (Omit<RealtimeVoiceBrowserSessionCreateRequest, "clientControl" | "gatewayControl"> & {
      clientControl: { owner: "gateway" };
      gatewayControl: RealtimeVoiceGatewayControl;
      gaSession: Record<string, unknown> & { model: string };
      gaSideband: {
        createBridge: (params: {
          apiKey: string;
          callId: string;
          onTerminal: () => void;
        }) => RealtimeVoiceBridge;
      };
    })
);

type PreparedOpenAIQuicksilverSessionRequest = OpenAIQuicksilverSessionRequest & {
  model: string;
};

type PendingOffer = {
  auth: OpenAIQuicksilverAuth;
  expiresAt: number;
  requestIds: OpenAIQuicksilverRequestIds;
  request: PreparedOpenAIQuicksilverSessionRequest;
  nativeControl?: RealtimeVoiceGatewayControl & {
    bindControl: NonNullable<RealtimeVoiceGatewayControl["bindControl"]>;
  };
  timer: NodeJS.Timeout;
};

type OpenAIRealtimeOfferMetrics = {
  callCreateMs: number;
  sidebandReadyMs: number;
  totalOfferMs: number;
};

export function createOpenAIQuicksilverBrowserSessionBroker(params: {
  getConfig: () => OpenClawConfig | undefined;
  logger: Pick<PluginLogger, "debug" | "warn">;
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
  onCleanupComplete?: () => void;
}): {
  broker: {
    capabilities: Partial<RealtimeVoiceProviderCapabilities> & { handlesAgentConsult: true };
    createBrowserSession: (
      request: OpenAIQuicksilverSessionRequest,
      auth: OpenAIQuicksilverAuth,
    ) => Promise<RealtimeVoiceBrowserSession>;
    cancelBrowserSession: (session: RealtimeVoiceBrowserSession) => Promise<void> | void;
  };
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  cleanup: () => Promise<void>;
  getSessionCounts: () => {
    pending: number;
    inFlight: number;
    active: number;
    reservations: number;
  };
} {
  const pendingOffers = new Map<string, PendingOffer>();
  const inFlightOffers = new Map<
    string,
    { controller: AbortController; completed: Promise<void> }
  >();
  const reservations = new Set<string>();
  const shutdownController = new AbortController();
  const createSocket = params.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  let cleanedUp = false;
  let cleanupInFlight: Promise<void> | undefined;

  const notifyCleanupComplete = () => {
    if (
      cleanedUp &&
      reservations.size === 0 &&
      pendingOffers.size === 0 &&
      inFlightOffers.size === 0 &&
      activeSessions.size === 0 &&
      retiringSessions.size === 0
    ) {
      params.onCleanupComplete?.();
    }
  };

  const releaseReservation = (token: string) => {
    reservations.delete(token);
    releaseOpenAIQuicksilverSession(token);
  };

  const expirePendingOffer = (token: string, offer: PendingOffer) => {
    if (pendingOffers.get(token) !== offer) {
      return;
    }
    pendingOffers.delete(token);
    clearTimeout(offer.timer);
    releaseReservation(token);
    try {
      offer.request.gatewayControl?.onClose?.("completed");
    } catch {
      params.logger.warn("OpenAI realtime terminal callback failed");
    }
  };

  const activeSessionLease = createOpenAIRealtimeSessionLease({
    logger: params.logger,
    releaseReservation,
    onSettled: notifyCleanupComplete,
  });
  const { activeSessions, retiringSessions } = activeSessionLease;

  const attachSidebandHandlers = (session: OpenAIRealtimeSession) => {
    if (!session.socket) {
      return;
    }
    const socket = session.socket;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      session.handleFrame?.(data, isBinary);
    });
    socket.on("error", (error: Error) => {
      params.logger.warn(`OpenAI GPT-Live sideband socket failed: ${error.message}`);
      void activeSessionLease.close(session, "abort", error).catch(() => undefined);
    });
    socket.on("close", (code) => {
      const error =
        code === 1000
          ? undefined
          : new Error(`OpenAI GPT-Live sideband closed unexpectedly (code ${code ?? 1006})`);
      void activeSessionLease.close(session, "abort", error).catch(() => undefined);
    });
  };

  const prunePendingOffers = () => {
    const now = Date.now();
    for (const [token, offer] of pendingOffers) {
      if (offer.expiresAt <= now) {
        expirePendingOffer(token, offer);
      }
    }
  };

  const broker = {
    capabilities: OPENAI_QUICKSILVER_CAPABILITIES,
    createBrowserSession: async (
      request: OpenAIQuicksilverSessionRequest,
      auth: OpenAIQuicksilverAuth,
    ): Promise<RealtimeVoiceBrowserSession> => {
      if (cleanedUp || shutdownController.signal.aborted) {
        throw new Error("OpenAI GPT-Live sessions are stopping; restart Gateway and try again");
      }
      const model = request.model?.trim();
      if (!model) {
        throw new Error("OpenAI realtime browser sessions require a model");
      }
      const isGptLive = isOpenAIGptLiveModel(model);
      if (isGptLive && !request.runAgentConsult) {
        throw new Error("OpenAI GPT-Live requires the Gateway agent-consult runtime");
      }
      let nativeControl: PendingOffer["nativeControl"];
      if (isGptLive && request.clientControl?.owner === "gateway") {
        const control = request.gatewayControl;
        if (!control?.bindControl) {
          throw new Error("Native realtime Gateway control requires the host control binding");
        }
        // Keep the negotiated callbacks separate from legacy delegation lifecycle callbacks.
        nativeControl = { ...control, bindControl: control.bindControl };
      }
      if (!isGptLive) {
        if (!request.gaSession) {
          throw new Error("OpenAI GA realtime browser sessions require an initial session policy");
        }
        if (request.gaSession.model !== model) {
          throw new Error("OpenAI GA realtime session policy model must match the requested model");
        }
      }
      prunePendingOffers();
      const voice = isGptLive ? resolveOpenAIQuicksilverVoice(request.voice) : request.voice;
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + OPENAI_QUICKSILVER_PENDING_TTL_MS;
      reserveOpenAIQuicksilverSession(token, {
        expiresAtMs: expiresAt,
        ownerConnId: request.clientControl?.owner === "gateway" ? request.ownerConnId : undefined,
      });
      const offer: PendingOffer = {
        auth,
        expiresAt,
        requestIds: {
          realtimeSessionId: randomUUID(),
          sessionId: randomUUID(),
          threadId: randomUUID(),
        },
        request: { ...request, model, voice },
        nativeControl,
        timer: setTimeout(
          () => expirePendingOffer(token, offer),
          OPENAI_QUICKSILVER_PENDING_TTL_MS,
        ),
      };
      offer.timer.unref?.();
      pendingOffers.set(token, offer);
      reservations.add(token);
      return {
        provider: "openai",
        transport: "webrtc",
        clientSecret: token,
        offerUrl: OPENAI_QUICKSILVER_OFFER_PATH,
        offerResponseMaxBytes: 256 * 1024,
        ...(request.gaSideband ? {} : { model, voice }),
        expiresAt,
      };
    },
    cancelBrowserSession: async (session: RealtimeVoiceBrowserSession) => {
      if (session.transport !== "webrtc") {
        return;
      }
      const pending = pendingOffers.get(session.clientSecret);
      if (pending) {
        pendingOffers.delete(session.clientSecret);
        clearTimeout(pending.timer);
      }
      const inFlight = inFlightOffers.get(session.clientSecret);
      inFlight?.controller.abort(new Error("OpenAI realtime session canceled"));
      const active =
        activeSessions.get(session.clientSecret) ?? retiringSessions.get(session.clientSecret);
      if (active) {
        await activeSessionLease.close(active, "detach");
      } else if (inFlight) {
        await inFlight.completed;
      } else {
        releaseReservation(session.clientSecret);
      }
    },
  };

  const handleOffer = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const corsAllowed = applyRealtimeOfferCorsHeaders(req, res, params.getConfig());
    if (!corsAllowed) {
      respondRealtimeOffer(res, 403, "Origin not allowed");
      return true;
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("cache-control", "no-store");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader(
        "Vary",
        "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      );
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      res.setHeader("Access-Control-Max-Age", "600");
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      respondRealtimeOffer(res, 405, "Method not allowed");
      return true;
    }
    const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/sdp") {
      respondRealtimeOffer(res, 415, "Expected application/sdp");
      return true;
    }
    prunePendingOffers();
    const token = readOfferBearerToken(req);
    const offer = token ? pendingOffers.get(token) : undefined;
    if (!token || !offer || offer.expiresAt <= Date.now()) {
      respondRealtimeOffer(res, 401, "Invalid or expired realtime session token");
      return true;
    }
    // Offer credentials are single-use so a captured browser request cannot join twice.
    // In-flight creation now owns the reservation through late allocation/retirement.
    reserveOpenAIQuicksilverSession(token, {
      ownerConnId:
        offer.request.clientControl?.owner === "gateway" ? offer.request.ownerConnId : undefined,
    });
    pendingOffers.delete(token);
    clearTimeout(offer.timer);
    const requestController = new AbortController();
    let browserDisconnected = false;
    const completion = createDeferred<void>();
    // HTTP error delivery and cancellation have separate outcomes. Observe the
    // cleanup rejection even when no cancel/cleanup caller joins this token.
    void completion.promise.catch(() => undefined);
    inFlightOffers.set(token, { controller: requestController, completed: completion.promise });
    const abortFromBrowser = () => {
      browserDisconnected = true;
      requestController.abort(new Error("Browser GPT-Live offer request closed"));
    };
    req.once("aborted", abortFromBrowser);
    res.once("close", abortFromBrowser);
    const detachBrowserAbort = () => {
      req.removeListener("aborted", abortFromBrowser);
      res.removeListener("close", abortFromBrowser);
    };
    const lifecycleSignal = AbortSignal.any([shutdownController.signal, requestController.signal]);
    let session: OpenAIRealtimeSession | undefined;
    let responseDeliveryWaiter: ReturnType<typeof createResponseDeliveryWaiter> | undefined;
    let terminalReported = false;
    const reportTerminal = (error?: Error) => {
      if (terminalReported) {
        return;
      }
      // Disposal, buffered startup failure, and callback reentrancy share one terminal outcome.
      terminalReported = true;
      try {
        try {
          if (error) {
            offer.request.gatewayControl?.onError?.(error);
          }
        } finally {
          offer.request.gatewayControl?.onClose?.(error ? "error" : "completed");
        }
      } catch {
        params.logger.warn("OpenAI realtime terminal callback failed");
      }
    };
    const deliverActiveAnswer = async (status: number, answerSdp: string): Promise<boolean> => {
      responseDeliveryWaiter = createResponseDeliveryWaiter(res, detachBrowserAbort);
      respondRealtimeOffer(res, status, answerSdp, "application/sdp");
      const delivered = await responseDeliveryWaiter.result;
      responseDeliveryWaiter = undefined;
      return delivered;
    };
    try {
      const offerStartedAt = Date.now();
      const sdp = await readRequestBodyWithLimit(req, {
        maxBytes: OPENAI_QUICKSILVER_MAX_SDP_BYTES,
        timeoutMs: 15_000,
        // Defer destruction so the rejection below reaches the browser before the close.
        destroyOnLimit: false,
      });
      try {
        if (!sdp.trim()) {
          throw new Error("SDP offer is required");
        }
        if (offer.request.clientControl?.owner === "gateway") {
          assertOpenAIRealtimeAudioOnlyOffer(sdp);
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Invalid SDP offer");
        reportTerminal(failure);
        respondRealtimeOffer(res, 400, failure.message);
        return true;
      }
      const upstreamSignal = AbortSignal.any([
        lifecycleSignal,
        AbortSignal.timeout(OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS),
      ]);
      const sessionConfig = isOpenAIGptLiveModel(offer.request.model)
        ? buildOpenAIQuicksilverSession({
            model: offer.request.model,
            hostControlsInput: Boolean(offer.nativeControl?.handleDelegationInput),
            instructions: offer.request.instructions,
            voice: offer.request.voice,
            initialItems: offer.request.initialItems,
          })
        : offer.request.gaSession;
      if (!sessionConfig) {
        throw new Error("OpenAI GA realtime browser sessions require an initial session policy");
      }
      const gaSideband = offer.request.gaSideband;
      if (gaSideband) {
        if (offer.auth.type !== "api-key") {
          throw new Error("OpenAI Realtime Gateway control requires a Platform API key");
        }
        const callStartedAt = Date.now();
        const call = await createOpenAIQuicksilverCall(
          {
            auth: offer.auth,
            requestIds: offer.requestIds,
            sdp,
            session: sessionConfig,
            gaSideband: true,
            onCallAllocated: (callId) => {
              session = activeSessionLease.adopt(token, {
                dispose: () =>
                  hangupOpenAIRealtimeCall(
                    {
                      apiKey: offer.auth.token,
                      callId,
                      signal: AbortSignal.timeout(OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS),
                      fetchImpl: params.fetchImpl,
                    },
                    openAIRealtimeHost,
                  ),
              });
              activeSessionLease.expireIn(session, OPENAI_QUICKSILVER_SESSION_TTL_MS);
            },
            signal: upstreamSignal,
            fetchImpl: params.fetchImpl,
          },
          openAIRealtimeHost,
        );
        const active = activeSessions.get(token);
        if (call.kind !== "ga-sideband" || !active) {
          throw new Error("OpenAI Realtime call did not retain an active sideband session");
        }
        const callCreatedAt = Date.now();
        lifecycleSignal.throwIfAborted();
        const bridge = gaSideband.createBridge({
          apiKey: offer.auth.token,
          callId: call.callId,
          onTerminal: () => {
            if (activeSessions.get(token) === active) {
              void activeSessionLease.close(active).catch(() => undefined);
            }
          },
        });
        active.retire = () => bridge.close();
        if (activeSessions.get(token) !== active) {
          bridge.close();
          throw new Error("OpenAI Realtime sideband stopped during construction");
        }
        lifecycleSignal.throwIfAborted();
        await bridge.connect();
        if (lifecycleSignal.aborted || activeSessions.get(token) !== active) {
          throw (
            lifecycleSignal.reason ?? new Error("OpenAI Realtime sideband stopped during startup")
          );
        }
        const sidebandReadyAt = Date.now();
        const metrics: OpenAIRealtimeOfferMetrics = {
          callCreateMs: callCreatedAt - callStartedAt,
          sidebandReadyMs: sidebandReadyAt - callCreatedAt,
          totalOfferMs: sidebandReadyAt - offerStartedAt,
        };
        params.logger.debug?.(`OpenAI Realtime sideband offer ready ${JSON.stringify(metrics)}`);
        await activeSessionLease.deliverAnswer(active, lifecycleSignal, () =>
          deliverActiveAnswer(call.status, call.answerSdp),
        );
        return true;
      }
      const call = await createOpenAIQuicksilverCall(
        {
          auth: offer.auth,
          requestIds: offer.requestIds,
          sdp,
          session: sessionConfig,
          signal: upstreamSignal,
          fetchImpl: params.fetchImpl,
        },
        openAIRealtimeHost,
      );
      if (call.kind === "ga-realtime") {
        respondRealtimeOffer(res, call.status, call.answerSdp, "application/sdp");
        return true;
      }
      const runAgentConsult = offer.request.runAgentConsult;
      if (!runAgentConsult) {
        throw new Error("OpenAI GPT-Live requires the Gateway agent-consult runtime");
      }
      const connected = await connectOpenAIQuicksilverSideband(
        {
          auth: offer.auth,
          createSocket,
          requestIds: offer.requestIds,
          signal: lifecycleSignal,
          url: call.sidebandUrl,
        },
        openAIRealtimeHost,
      );
      if (lifecycleSignal.aborted) {
        connected.socket.close(1000, "session stopped");
        throw lifecycleSignal.reason;
      }
      const abortController = new AbortController();
      const nativeControl = offer.nativeControl;
      const delegations = new OpenAIQuicksilverDelegationController(
        {
          getSocket: () => connected.socket,
          logger: params.logger,
          onError: (error) => offer.request.gatewayControl?.onError?.(error),
          onFatalError: (error) => {
            if (session) {
              void activeSessionLease.close(session, "abort", error).catch(() => undefined);
            }
          },
          onSessionStarted: (expiresAt) => {
            if (session && expiresAt !== undefined) {
              const upstreamTtlMs = expiresAt * 1000 - Date.now();
              activeSessionLease.expireIn(
                session,
                Math.min(OPENAI_QUICKSILVER_SESSION_TTL_MS, upstreamTtlMs),
              );
            }
          },
          ...(nativeControl
            ? {
                onTranscript: nativeControl.onTranscript,
                handleDelegationInput: nativeControl.handleDelegationInput,
                onWireEventType: (type: string) =>
                  nativeControl.onEvent?.({ direction: "server", type }),
              }
            : {}),
          runAgentConsult,
          signal: abortController.signal,
        },
        openAIRealtimeHost.formatErrorMessage,
      );
      session = activeSessionLease.adopt(token, {
        detach: () => delegations.detach(),
        retire: (error) => {
          delegations.stop(new Error("GPT-Live delegation stopped"));
          abortController.abort(new Error("GPT-Live session closed"));
          if (connected.socket.readyState === WEBSOCKET_OPEN) {
            try {
              connected.socket.send(JSON.stringify({ type: "session.close" }));
            } catch {
              // The peer may have closed between readyState and send.
            }
          }
          try {
            connected.socket.close(1000, "session closed");
          } catch {
            // Socket teardown is best effort after ownership has been released.
          }
          reportTerminal(error);
        },
        handleFrame: (data, isBinary) => delegations.handleFrame(data, isBinary),
        socket: connected.socket,
      });
      activeSessionLease.expireIn(session, OPENAI_QUICKSILVER_SESSION_TTL_MS);
      nativeControl?.bindControl({
        sendUserMessage: (text) => delegations.sendSessionContext(text, "speakable"),
      });
      attachSidebandHandlers(session);
      const terminalEvent = connected.detachBuffer();
      for (const frame of connected.bufferedFrames) {
        session.handleFrame?.(frame.data, frame.isBinary);
      }
      if (terminalEvent && activeSessions.get(token) === session) {
        if (terminalEvent.kind === "error") {
          params.logger.warn(
            `OpenAI GPT-Live sideband socket failed: ${terminalEvent.error.message}`,
          );
        }
        await activeSessionLease.close(
          session,
          "abort",
          terminalEvent.kind === "error"
            ? terminalEvent.error
            : new Error("OpenAI GPT-Live sideband failed during startup"),
        );
      }
      if (activeSessions.get(token) !== session) {
        throw new Error("OpenAI GPT-Live sideband failed during startup");
      }
      // The call was configured at creation; attaching its sideband needs no new session.started.
      nativeControl?.onReady?.();
      if (lifecycleSignal.aborted || activeSessions.get(token) !== session) {
        throw new Error("OpenAI GPT-Live session closed during readiness notification");
      }

      await activeSessionLease.deliverAnswer(session, lifecycleSignal, () =>
        deliverActiveAnswer(200, call.answerSdp),
      );
      return true;
    } catch (error) {
      const sessionError =
        error instanceof Error ? error : new Error("OpenAI realtime session failed");
      // Host notification failures cannot skip the allocated call's cleanup owner.
      // GPT-Live disposal already owns its terminal outcome.
      if (offer.request.gaSideband || !session) {
        reportTerminal(sessionError);
      }
      if (session && activeSessions.get(token) === session) {
        // Startup already has a visible failure; a failed retirement keeps its
        // own retry obligation rather than preventing the HTTP error response.
        await activeSessionLease.close(session, "abort", sessionError).catch(() => undefined);
      }
      if (browserDisconnected || res.headersSent) {
        return true;
      }
      if (await rejectOversizedOffer(req, res, error)) {
        return true;
      }
      respondRealtimeOffer(res, 502, sessionError.message);
      return true;
    } finally {
      responseDeliveryWaiter?.cancel();
      detachBrowserAbort();
      // Join the original retirement, including one started reentrantly by the
      // bridge. Calling close again here would reset a failed attempt's retry budget.
      const [retirement] = await Promise.allSettled([session?.initialRetirement]);
      inFlightOffers.delete(token);
      if (!session) {
        releaseReservation(token);
      }
      if (retirement?.status === "rejected") {
        completion.reject(retirement.reason);
      } else {
        completion.resolve();
      }
      notifyCleanupComplete();
    }
  };

  const cleanup = (): Promise<void> => {
    if (cleanupInFlight) {
      return cleanupInFlight;
    }
    cleanedUp = true;
    cleanupInFlight = Promise.resolve().then(async () => {
      const closingSessions = [...activeSessions.values(), ...retiringSessions.values()].map(
        (session) => activeSessionLease.close(session),
      );
      const results = await Promise.allSettled([
        ...Array.from(inFlightOffers.values(), ({ completed }) => completed),
        ...closingSessions,
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0 || retiringSessions.size > 0) {
        throw new AggregateError(failures, "OpenAI realtime remote cleanup remains incomplete");
      }
      notifyCleanupComplete();
    });
    shutdownController.abort(new Error("OpenAI realtime broker stopped"));
    for (const [token, offer] of pendingOffers) {
      expirePendingOffer(token, offer);
    }
    for (const { controller } of inFlightOffers.values()) {
      controller.abort(new Error("OpenAI realtime broker stopped"));
    }
    return cleanupInFlight.finally(() => {
      cleanupInFlight = undefined;
    });
  };

  return {
    broker,
    handler: handleOffer,
    cleanup,
    getSessionCounts: () => ({
      pending: pendingOffers.size,
      inFlight: inFlightOffers.size,
      active: activeSessions.size,
      reservations: reservations.size,
    }),
  };
}
