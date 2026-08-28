// Native GPT-Live browser sessions: WebRTC offer broker plus gateway-owned sideband control.
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveOpenAICodexAuthIdentity,
  resolveProviderAuthProfileApiKey,
} from "openclaw/plugin-sdk/provider-auth";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
} from "openclaw/plugin-sdk/realtime-voice";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import WebSocket, { type RawData } from "ws";
import { OpenAIQuicksilverDelegationController } from "./realtime-quicksilver-delegation-controller.js";
import {
  applyRealtimeOfferCorsHeaders,
  createResponseDeliveryWaiter,
  readOfferBearerToken,
  rejectOversizedOffer,
  respondOfferText,
  type ResponseDeliveryWaiter,
} from "./realtime-quicksilver-offer-http.js";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";
import {
  connectOpenAIQuicksilverSideband,
  type OpenAIQuicksilverSocket,
  type OpenAIQuicksilverSocketFactory,
} from "./realtime-quicksilver-sideband.js";
import {
  buildOpenAIQuicksilverSession,
  createOpenAIQuicksilverCall,
  hangupOpenAIRealtimeCall,
  resolveOpenAIQuicksilverVoice,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInitialItem,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";
import { isOpenAIGptLiveModel } from "./realtime-quicksilver.js";
import { assertOpenAIRealtimeAudioOnlyOffer } from "./realtime-sdp-offer.js";
export const OPENAI_QUICKSILVER_OFFER_PATH = "/plugins/openai/realtime/calls";
export const OPENAI_QUICKSILVER_CAPABILITIES = {
  transports: ["webrtc" as const, "gateway-relay" as const],
  handlesAgentConsult: true as const,
  supportsToolCalls: false,
  supportsVideoFrames: false,
} satisfies Partial<RealtimeVoiceProviderCapabilities> & { handlesAgentConsult: true };

const OPENAI_QUICKSILVER_PENDING_TTL_MS = 60_000;
const OPENAI_QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const OPENAI_REALTIME_MAX_SESSIONS_PER_OWNER = 2;
const OPENAI_QUICKSILVER_MAX_SDP_BYTES = 256 * 1024;
const OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverSessionRequest = RealtimeVoiceBrowserSessionCreateRequest & {
  initialItems?: OpenAIQuicksilverInitialItem[];
  ownerConnId?: string;
  gaSession?: Record<string, unknown> & { model: string };
  gaSideband?: {
    createBridge: (params: {
      apiKey: string;
      callId: string;
      onTerminal: () => void;
    }) => RealtimeVoiceBridge;
  };
};

type PreparedOpenAIQuicksilverSessionRequest = OpenAIQuicksilverSessionRequest & {
  model: string;
  voice: string;
};

type PendingOffer = {
  auth: OpenAIQuicksilverAuth;
  expiresAt: number;
  requestIds: OpenAIQuicksilverRequestIds;
  request: PreparedOpenAIQuicksilverSessionRequest;
  timer: NodeJS.Timeout;
};

type ActiveSession = {
  closing?: Promise<void>;
  dispose: () => Promise<void> | void;
  handleFrame?: (data: RawData, isBinary: boolean) => void;
  socket?: OpenAIQuicksilverSocket;
  timer?: NodeJS.Timeout;
  token: string;
};

type OpenAIRealtimeOfferMetrics = {
  callCreateMs: number;
  sidebandReadyMs: number;
  totalOfferMs: number;
};

export async function resolveOpenAIChatGptSubscriptionAuth(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<Extract<OpenAIQuicksilverAuth, { type: "oauth" }> | undefined> {
  const token = await resolveProviderAuthProfileApiKey({
    provider: "openai",
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileTypes: ["oauth"],
    includeExternalCliAuth: false,
  });
  if (!token) {
    return undefined;
  }
  const accountId = resolveOpenAICodexAuthIdentity({ access: token }).accountId;
  if (!accountId) {
    throw new Error("The selected ChatGPT OAuth profile is missing its account id");
  }
  return { type: "oauth", token, accountId };
}

export function createOpenAIQuicksilverBrowserSessionBroker(params: {
  getConfig: () => OpenClawConfig | undefined;
  logger: Pick<PluginLogger, "debug" | "warn">;
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAIQuicksilverSocketFactory;
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
  const inFlightOffers = new Map<string, AbortController>();
  const activeSessions = new Map<string, ActiveSession>();
  const reservations = new Set<string>();
  const reservationOwners = new Map<string, string>();
  const inFlightHandlers = new Set<Promise<boolean>>();
  const shutdownController = new AbortController();
  const createSocket = params.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  let cleanedUp = false;

  const releaseReservation = (token: string) => {
    reservations.delete(token);
    reservationOwners.delete(token);
    releaseOpenAIQuicksilverSession(token);
  };

  const expirePendingOffer = (token: string, offer: PendingOffer) => {
    if (pendingOffers.get(token) !== offer) {
      return;
    }
    pendingOffers.delete(token);
    clearTimeout(offer.timer);
    releaseReservation(token);
    offer.request.gatewayControl?.onClose?.("completed");
  };

  const activeSessionLease = {
    adopt: (token: string, wire: Omit<ActiveSession, "token">): ActiveSession => {
      const session = { token, ...wire };
      activeSessions.set(token, session);
      reserveOpenAIQuicksilverSession(token);
      return session;
    },
    close: async (session: ActiveSession): Promise<void> => {
      if (session.closing) {
        return session.closing;
      }
      if (activeSessions.get(session.token) !== session) {
        return;
      }
      activeSessions.delete(session.token);
      releaseReservation(session.token);
      clearTimeout(session.timer);
      // Publish closing before synchronous wire disposal can re-enter this method.
      session.closing = Promise.resolve();
      session.closing = Promise.resolve(session.dispose());
      return session.closing;
    },
    expireIn: (session: ActiveSession, ttlMs: number) => {
      clearTimeout(session.timer);
      session.timer = setTimeout(() => void activeSessionLease.close(session), Math.max(0, ttlMs));
      session.timer.unref?.();
    },
    deliverAnswer: async (
      session: ActiveSession,
      signal: AbortSignal,
      deliver: () => Promise<boolean>,
    ) => {
      if (!(await deliver()) || signal.aborted) {
        await activeSessionLease.close(session);
      }
    },
  };

  const attachSidebandHandlers = (session: ActiveSession) => {
    if (!session.socket) {
      return;
    }
    const socket = session.socket;
    socket.on("message", (data: RawData, isBinary: boolean) => {
      session.handleFrame?.(data, isBinary);
    });
    socket.on("error", (error: Error) => {
      params.logger.warn(`OpenAI GPT-Live sideband socket failed: ${error.message}`);
      void activeSessionLease.close(session);
    });
    socket.on("close", () => void activeSessionLease.close(session));
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
      if (!isGptLive) {
        if (!request.gaSession) {
          throw new Error("OpenAI GA realtime browser sessions require an initial session policy");
        }
        if (request.gaSession.model !== model) {
          throw new Error("OpenAI GA realtime session policy model must match the requested model");
        }
      }
      prunePendingOffers();
      if (
        request.gaSideband &&
        request.ownerConnId &&
        Array.from(reservationOwners.values()).filter((owner) => owner === request.ownerConnId)
          .length >= OPENAI_REALTIME_MAX_SESSIONS_PER_OWNER
      ) {
        throw new Error("Too many concurrent OpenAI realtime sessions for this client");
      }
      const voice = resolveOpenAIQuicksilverVoice(request.voice);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + OPENAI_QUICKSILVER_PENDING_TTL_MS;
      reserveOpenAIQuicksilverSession(token, { expiresAtMs: expiresAt });
      const offer: PendingOffer = {
        auth,
        expiresAt,
        requestIds: {
          realtimeSessionId: randomUUID(),
          sessionId: randomUUID(),
          threadId: randomUUID(),
        },
        request: { ...request, model, voice },
        timer: setTimeout(
          () => expirePendingOffer(token, offer),
          OPENAI_QUICKSILVER_PENDING_TTL_MS,
        ),
      };
      offer.timer.unref?.();
      pendingOffers.set(token, offer);
      reservations.add(token);
      if (request.gaSideband && request.ownerConnId) {
        reservationOwners.set(token, request.ownerConnId);
      }
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
      inFlightOffers
        .get(session.clientSecret)
        ?.abort(new Error("OpenAI realtime session canceled"));
      const active = activeSessions.get(session.clientSecret);
      if (active) {
        await activeSessionLease.close(active);
      } else {
        releaseReservation(session.clientSecret);
      }
    },
  };

  const handleOffer = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const corsAllowed = applyRealtimeOfferCorsHeaders(req, res, params.getConfig());
    if (req.method === "OPTIONS") {
      if (!corsAllowed) {
        respondOfferText(res, 403, "Origin not allowed");
        return true;
      }
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
    if (!corsAllowed) {
      respondOfferText(res, 403, "Origin not allowed");
      return true;
    }
    if (req.method !== "POST") {
      respondOfferText(res, 405, "Method not allowed");
      return true;
    }
    const mediaType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/sdp") {
      respondOfferText(res, 415, "Expected application/sdp");
      return true;
    }
    prunePendingOffers();
    const token = readOfferBearerToken(req);
    const offer = token ? pendingOffers.get(token) : undefined;
    if (!token || !offer || offer.expiresAt <= Date.now()) {
      respondOfferText(res, 401, "Invalid or expired realtime session token");
      return true;
    }
    // Offer credentials are single-use so a captured browser request cannot join twice.
    pendingOffers.delete(token);
    clearTimeout(offer.timer);
    const requestController = new AbortController();
    let browserDisconnected = false;
    inFlightOffers.set(token, requestController);
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
    let session: ActiveSession | undefined;
    let responseDeliveryWaiter: ResponseDeliveryWaiter | undefined;
    const deliverActiveAnswer = async (status: number, answerSdp: string): Promise<boolean> => {
      responseDeliveryWaiter = createResponseDeliveryWaiter(res, detachBrowserAbort);
      res.statusCode = status;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/sdp");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(answerSdp);
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
      if (!sdp.trim()) {
        respondOfferText(res, 400, "SDP offer is required");
        return true;
      }
      const upstreamSignal = AbortSignal.any([
        lifecycleSignal,
        AbortSignal.timeout(OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS),
      ]);
      const sessionConfig = isOpenAIGptLiveModel(offer.request.model)
        ? buildOpenAIQuicksilverSession({
            model: offer.request.model,
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
        try {
          assertOpenAIRealtimeAudioOnlyOffer(sdp);
        } catch (error) {
          respondOfferText(res, 400, error instanceof Error ? error.message : "Invalid SDP offer");
          return true;
        }
        if (offer.auth.type !== "api-key") {
          throw new Error("OpenAI Realtime Gateway control requires a Platform API key");
        }
        const callStartedAt = Date.now();
        const call = await createOpenAIQuicksilverCall({
          auth: offer.auth,
          requestIds: offer.requestIds,
          sdp,
          session: sessionConfig,
          gaSideband: true,
          signal: upstreamSignal,
          fetchImpl: params.fetchImpl,
        });
        if (call.kind !== "ga-sideband") {
          throw new Error("OpenAI Realtime call did not create a sideband session");
        }
        const callCreatedAt = Date.now();
        let bridge: RealtimeVoiceBridge;
        try {
          bridge = gaSideband.createBridge({
            apiKey: offer.auth.token,
            callId: call.callId,
            onTerminal: () => {
              const active = activeSessions.get(token);
              if (active) {
                void activeSessionLease.close(active);
              }
            },
          });
        } catch (error) {
          await hangupOpenAIRealtimeCall({
            apiKey: offer.auth.token,
            callId: call.callId,
            signal: AbortSignal.timeout(OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS),
            fetchImpl: params.fetchImpl,
          }).catch(() => undefined);
          throw error;
        }
        const active = activeSessionLease.adopt(token, {
          dispose: async () => {
            try {
              bridge.close();
            } catch (error) {
              params.logger.warn(
                `OpenAI Realtime sideband close failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            try {
              await hangupOpenAIRealtimeCall({
                apiKey: offer.auth.token,
                callId: call.callId,
                signal: AbortSignal.timeout(OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS),
                fetchImpl: params.fetchImpl,
              });
            } catch (error) {
              params.logger.warn(
                `OpenAI Realtime call cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
        });
        activeSessionLease.expireIn(active, OPENAI_QUICKSILVER_SESSION_TTL_MS);
        session = active;
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
      const call = await createOpenAIQuicksilverCall({
        auth: offer.auth,
        requestIds: offer.requestIds,
        sdp,
        session: sessionConfig,
        signal: upstreamSignal,
        fetchImpl: params.fetchImpl,
      });
      if (call.kind === "ga-realtime") {
        res.statusCode = call.status;
        res.setHeader("cache-control", "no-store");
        res.setHeader("content-type", "application/sdp");
        res.setHeader("x-content-type-options", "nosniff");
        res.end(call.answerSdp);
        return true;
      }
      const runAgentConsult = offer.request.runAgentConsult;
      if (!runAgentConsult) {
        throw new Error("OpenAI GPT-Live requires the Gateway agent-consult runtime");
      }
      const connected = await connectOpenAIQuicksilverSideband({
        auth: offer.auth,
        createSocket,
        requestIds: offer.requestIds,
        signal: lifecycleSignal,
        url: call.sidebandUrl,
      });
      if (lifecycleSignal.aborted) {
        connected.socket.close(1000, "session stopped");
        throw lifecycleSignal.reason;
      }
      const abortController = new AbortController();
      const delegations = new OpenAIQuicksilverDelegationController({
        getSocket: () => connected.socket,
        logger: params.logger,
        onFatalError: () => {
          if (session) {
            void activeSessionLease.close(session);
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
        runAgentConsult,
        signal: abortController.signal,
      });
      session = activeSessionLease.adopt(token, {
        dispose: () => {
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
        },
        handleFrame: (data, isBinary) => delegations.handleFrame(data, isBinary),
        socket: connected.socket,
      });
      activeSessionLease.expireIn(session, OPENAI_QUICKSILVER_SESSION_TTL_MS);
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
        void activeSessionLease.close(session);
      }
      if (activeSessions.get(token) !== session) {
        throw new Error("OpenAI GPT-Live sideband failed during startup");
      }

      await activeSessionLease.deliverAnswer(session, lifecycleSignal, () =>
        deliverActiveAnswer(200, call.answerSdp),
      );
      return true;
    } catch (error) {
      if (session) {
        await activeSessionLease.close(session);
      }
      if (browserDisconnected) {
        return true;
      }
      if (await rejectOversizedOffer(req, res, error)) {
        return true;
      }
      respondOfferText(
        res,
        502,
        error instanceof Error ? error.message : "OpenAI realtime session failed",
      );
      return true;
    } finally {
      responseDeliveryWaiter?.cancel();
      detachBrowserAbort();
      inFlightOffers.delete(token);
      if (!session) {
        releaseReservation(token);
      }
    }
  };

  const handler = (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const handling = handleOffer(req, res);
    inFlightHandlers.add(handling);
    return handling.finally(() => inFlightHandlers.delete(handling));
  };

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    shutdownController.abort(new Error("OpenAI realtime broker stopped"));
    for (const [token, offer] of pendingOffers) {
      expirePendingOffer(token, offer);
    }
    for (const controller of inFlightOffers.values()) {
      controller.abort(new Error("OpenAI realtime broker stopped"));
    }
    const closingSessions = Array.from(activeSessions.values(), (session) =>
      activeSessionLease.close(session),
    );
    await Promise.allSettled(inFlightHandlers);
    await Promise.allSettled(closingSessions);
    for (const token of reservations) {
      releaseOpenAIQuicksilverSession(token);
    }
    reservations.clear();
    reservationOwners.clear();
  };

  return {
    broker,
    handler,
    cleanup,
    getSessionCounts: () => ({
      pending: pendingOffers.size,
      inFlight: inFlightOffers.size,
      active: activeSessions.size,
      reservations: reservations.size,
    }),
  };
}
