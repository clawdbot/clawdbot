// Native GPT-Live browser sessions: WebRTC offer broker plus gateway-owned sideband control.
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  readRequestBodyWithLimit,
  resolveAcceptedBrowserOrigin,
} from "openclaw/plugin-sdk/webhook-request-guards";
import WebSocket, { type RawData } from "ws";
import { resolveCodexAuthIdentity } from "./openai-chatgpt-auth-identity.js";
import {
  buildOpenAIQuicksilverDelegationPrompt,
  type OpenAIQuicksilverTranscriptEntry,
} from "./realtime-quicksilver-instructions.js";
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
  boundOpenAIQuicksilverContextItems,
  buildOpenAIQuicksilverSession,
  chunkOpenAIQuicksilverAppendText,
  createOpenAIQuicksilverCall,
  parseOpenAIQuicksilverEvent,
  resolveOpenAIQuicksilverVoice,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverInboundEvent,
  type OpenAIQuicksilverInitialItem,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";
import { isOpenAIGptLiveModel } from "./realtime-quicksilver.js";
export const OPENAI_QUICKSILVER_OFFER_PATH = "/plugins/openai/realtime/calls";
export const OPENAI_QUICKSILVER_CAPABILITIES = {
  transports: ["webrtc" as const, "gateway-relay" as const],
  handlesAgentConsult: true as const,
  supportsToolCalls: false,
  supportsVideoFrames: false,
} satisfies Partial<RealtimeVoiceProviderCapabilities> & { handlesAgentConsult: true };

const OPENAI_QUICKSILVER_PENDING_TTL_MS = 60_000;
const OPENAI_QUICKSILVER_SESSION_TTL_MS = 30 * 60_000;
const OPENAI_QUICKSILVER_MAX_SDP_BYTES = 256 * 1024;
const OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN = 1;

type OpenAIQuicksilverSessionRequest = RealtimeVoiceBrowserSessionCreateRequest & {
  initialItems?: OpenAIQuicksilverInitialItem[];
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
};

type PendingDelegation = {
  id: string;
  prompt: string;
};

type ActiveSession = {
  abortController: AbortController;
  consultController?: AbortController;
  pendingDelegation?: PendingDelegation;
  socket: OpenAIQuicksilverSocket;
  timer: NodeJS.Timeout;
  token: string;
  transcript: OpenAIQuicksilverTranscriptEntry[];
  partialTranscriptRole: "user" | "assistant" | undefined;
};

type ResponseDeliveryWaiter = {
  result: Promise<boolean>;
  cancel: () => void;
};

function sendOpenAIQuicksilverAppend(params: {
  socket: OpenAIQuicksilverSocket;
  delegationItemId: string;
  text: string;
  channel: "speakable" | "commentary";
}): void {
  for (const chunk of chunkOpenAIQuicksilverAppendText(params.text)) {
    params.socket.send(
      JSON.stringify({
        type: "delegation.context.append",
        delegation_item_id: params.delegationItemId,
        channel: params.channel,
        content: [{ type: "input_text", text: chunk }],
      }),
    );
  }
}

const OPENAI_QUICKSILVER_CONSULT_FAILURE_TEXT =
  "The agent task failed. Tell the user it did not complete and offer to try again.";

function shortConsultFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s+/g, " ").trim().slice(0, 180) || "unknown error";
}

function decodeQuicksilverTextFrame(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function appendOpenAIQuicksilverTranscript(
  session: ActiveSession,
  event: Extract<OpenAIQuicksilverInboundEvent, { kind: "transcript-delta" | "transcript-done" }>,
): void {
  const last = session.transcript.at(-1);
  if (event.kind === "transcript-delta") {
    if (last?.role === event.role && session.partialTranscriptRole === event.role) {
      last.text += event.text;
    } else {
      session.transcript.push({ role: event.role, text: event.text });
    }
    session.partialTranscriptRole = event.role;
  } else {
    if (last?.role === event.role && session.partialTranscriptRole === event.role) {
      last.text = event.text;
    } else {
      session.transcript.push({ role: event.role, text: event.text });
    }
    session.partialTranscriptRole = undefined;
  }
  session.transcript = boundOpenAIQuicksilverContextItems(session.transcript);
}

function createResponseDeliveryWaiter(
  res: ServerResponse,
  onDelivered: () => void,
): ResponseDeliveryWaiter {
  let settle!: (delivered: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    settle = (delivered) => {
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      resolve(delivered);
    };
  });
  const onFinish = () => {
    onDelivered();
    settle(true);
  };
  const onClose = () => settle(false);
  res.once("finish", onFinish);
  res.once("close", onClose);
  return { result, cancel: () => settle(false) };
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

function applyRealtimeOfferCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig | undefined,
): boolean {
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveAcceptedBrowserOrigin({ req, cfg });
  if (!origin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization?.trim();
  return authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
}

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
  const accountId = resolveCodexAuthIdentity({ accessToken: token }).accountId;
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
    cancelBrowserSession: (session: RealtimeVoiceBrowserSession) => void;
  };
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  cleanup: () => Promise<void>;
} {
  const pendingOffers = new Map<string, PendingOffer>();
  const inFlightOffers = new Map<string, AbortController>();
  const activeSessions = new Map<string, ActiveSession>();
  const reservations = new Set<string>();
  const inFlightHandlers = new Set<Promise<boolean>>();
  const shutdownController = new AbortController();
  const createSocket = params.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
  let cleanedUp = false;

  const finalizeSession = (session: ActiveSession) => {
    if (activeSessions.get(session.token) !== session) {
      return false;
    }
    activeSessions.delete(session.token);
    reservations.delete(session.token);
    releaseOpenAIQuicksilverSession(session.token);
    clearTimeout(session.timer);
    session.pendingDelegation = undefined;
    session.consultController?.abort(new Error("GPT-Live delegation stopped"));
    session.abortController.abort(new Error("GPT-Live session closed"));
    return true;
  };

  const closeSession = (session: ActiveSession) => {
    if (!finalizeSession(session)) {
      return;
    }
    if (session.socket.readyState === WEBSOCKET_OPEN) {
      try {
        session.socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // The peer may have closed between readyState and send.
      }
    }
    try {
      session.socket.close(1000, "session closed");
    } catch {
      // Socket teardown is best effort after ownership has been released.
    }
  };

  const handleDelegation = async (
    session: ActiveSession,
    delegationItemId: string,
    prompt: string,
    signal: AbortSignal,
    runAgentConsult: NonNullable<OpenAIQuicksilverSessionRequest["runAgentConsult"]>,
  ) => {
    let finalText: string;
    try {
      const result = await runAgentConsult({ prompt, signal });
      if (signal.aborted) {
        return;
      }
      finalText = result.text;
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      // Agent failures can embed local paths, commands, or request data. The sideband is
      // an external provider surface the model may speak aloud, so only a fixed message
      // crosses it; the detail stays in Gateway logs.
      params.logger.warn(
        `OpenAI GPT-Live delegation consult failed: ${shortConsultFailureReason(error)}`,
      );
      finalText = OPENAI_QUICKSILVER_CONSULT_FAILURE_TEXT;
    }
    if (session.socket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    sendOpenAIQuicksilverAppend({
      socket: session.socket,
      delegationItemId,
      text: finalText,
      channel: "speakable",
    });
  };

  const startDelegation = (
    session: ActiveSession,
    delegation: PendingDelegation,
    runAgentConsult: NonNullable<OpenAIQuicksilverSessionRequest["runAgentConsult"]>,
  ) => {
    if (activeSessions.get(session.token) !== session || session.abortController.signal.aborted) {
      return;
    }
    if (session.consultController) {
      session.pendingDelegation = delegation;
      session.consultController.abort(new Error("GPT-Live delegation superseded"));
      return;
    }
    const consultController = new AbortController();
    session.consultController = consultController;
    const signal = AbortSignal.any([session.abortController.signal, consultController.signal]);
    void handleDelegation(session, delegation.id, delegation.prompt, signal, runAgentConsult)
      .catch((error: unknown) => {
        params.logger.warn(
          `OpenAI GPT-Live delegation failed: ${shortConsultFailureReason(error)}`,
        );
        closeSession(session);
      })
      .finally(() => {
        if (session.consultController !== consultController) {
          return;
        }
        session.consultController = undefined;
        const pending = session.pendingDelegation;
        session.pendingDelegation = undefined;
        if (pending && activeSessions.get(session.token) === session) {
          startDelegation(session, pending, runAgentConsult);
        }
      });
  };

  const scheduleSessionExpiry = (session: ActiveSession, ttlMs: number) => {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => closeSession(session), Math.max(0, ttlMs));
    session.timer.unref?.();
  };

  const handleSidebandEvent = (
    session: ActiveSession,
    event: OpenAIQuicksilverInboundEvent,
    runAgentConsult: NonNullable<OpenAIQuicksilverSessionRequest["runAgentConsult"]>,
  ) => {
    if (event.kind === "ignored") {
      return;
    }
    if (event.kind === "unknown") {
      params.logger.debug?.(`OpenAI GPT-Live ignored unknown sideband event: ${event.eventType}`);
      return;
    }
    if (event.kind === "session-started") {
      if (event.expiresAt !== undefined) {
        const upstreamTtlMs = event.expiresAt * 1000 - Date.now();
        scheduleSessionExpiry(session, Math.min(OPENAI_QUICKSILVER_SESSION_TTL_MS, upstreamTtlMs));
      }
      return;
    }
    if (event.kind === "transcript-delta" || event.kind === "transcript-done") {
      appendOpenAIQuicksilverTranscript(session, event);
      return;
    }
    if (event.kind === "error") {
      params.logger.warn(`OpenAI GPT-Live sideband error: ${event.message}`);
      if (event.fatalAuth) {
        closeSession(session);
      }
      return;
    }
    // WebRTC carries media separately; only the direct backend bridge consumes
    // Frameless output_audio.delta events received on the provider WebSocket.
    if (event.kind === "audio") {
      return;
    }
    const delegationInput = event.prompt;
    if (!delegationInput.trim()) {
      params.logger.debug?.("OpenAI GPT-Live ignored an empty client delegation");
      return;
    }
    // Drain only for a delegation we actually consult: the transcript is a
    // once-delivered delta, so clearing it for an ignored event would strand
    // that context and consult the next real delegation without it.
    const transcript = session.transcript;
    session.transcript = [];
    session.partialTranscriptRole = undefined;
    const prompt = buildOpenAIQuicksilverDelegationPrompt({
      input: delegationInput,
      transcript,
    });
    startDelegation(session, { id: event.id, prompt }, runAgentConsult);
  };

  const handleSidebandFrame = (
    session: ActiveSession,
    data: RawData,
    isBinary: boolean,
    runAgentConsult: NonNullable<OpenAIQuicksilverSessionRequest["runAgentConsult"]>,
  ) => {
    if (isBinary) {
      params.logger.warn("OpenAI GPT-Live sideband returned an unexpected binary frame");
      closeSession(session);
      return;
    }
    const event = parseOpenAIQuicksilverEvent(decodeQuicksilverTextFrame(data));
    if (event) {
      handleSidebandEvent(session, event, runAgentConsult);
    }
  };

  const attachSidebandHandlers = (
    session: ActiveSession,
    runAgentConsult: NonNullable<OpenAIQuicksilverSessionRequest["runAgentConsult"]>,
  ) => {
    session.socket.on("message", (data: RawData, isBinary: boolean) => {
      handleSidebandFrame(session, data, isBinary, runAgentConsult);
    });
    session.socket.on("error", (error: Error) => {
      params.logger.warn(`OpenAI GPT-Live sideband socket failed: ${error.message}`);
      closeSession(session);
    });
    session.socket.on("close", () => {
      finalizeSession(session);
    });
  };

  const prunePendingOffers = () => {
    const now = Date.now();
    for (const [token, offer] of pendingOffers) {
      if (offer.expiresAt <= now) {
        pendingOffers.delete(token);
        reservations.delete(token);
        releaseOpenAIQuicksilverSession(token);
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
      if (isOpenAIGptLiveModel(model) && !request.runAgentConsult) {
        throw new Error("OpenAI GPT-Live requires the Gateway agent-consult runtime");
      }
      prunePendingOffers();
      const voice = resolveOpenAIQuicksilverVoice(request.voice);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + OPENAI_QUICKSILVER_PENDING_TTL_MS;
      reserveOpenAIQuicksilverSession(token, { expiresAtMs: expiresAt });
      pendingOffers.set(token, {
        auth,
        expiresAt,
        requestIds: {
          realtimeSessionId: randomUUID(),
          sessionId: randomUUID(),
          threadId: randomUUID(),
        },
        request: { ...request, model, voice },
      });
      reservations.add(token);
      return {
        provider: "openai",
        transport: "webrtc",
        clientSecret: token,
        offerUrl: OPENAI_QUICKSILVER_OFFER_PATH,
        model,
        voice,
        expiresAt,
      };
    },
    cancelBrowserSession: (session: RealtimeVoiceBrowserSession) => {
      if (session.transport !== "webrtc") {
        return;
      }
      pendingOffers.delete(session.clientSecret);
      inFlightOffers.get(session.clientSecret)?.abort(new Error("GPT-Live session canceled"));
      const active = activeSessions.get(session.clientSecret);
      if (active) {
        closeSession(active);
      } else {
        reservations.delete(session.clientSecret);
        releaseOpenAIQuicksilverSession(session.clientSecret);
      }
    },
  };

  const handleOffer = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const corsAllowed = applyRealtimeOfferCorsHeaders(req, res, params.getConfig());
    if (req.method === "OPTIONS") {
      if (!corsAllowed) {
        respondText(res, 403, "Origin not allowed");
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
      respondText(res, 403, "Origin not allowed");
      return true;
    }
    if (req.method !== "POST") {
      respondText(res, 405, "Method not allowed");
      return true;
    }
    if (!req.headers["content-type"]?.toLowerCase().startsWith("application/sdp")) {
      respondText(res, 415, "Expected application/sdp");
      return true;
    }
    prunePendingOffers();
    const token = readBearerToken(req);
    const offer = token ? pendingOffers.get(token) : undefined;
    if (!token || !offer || offer.expiresAt <= Date.now()) {
      respondText(res, 401, "Invalid or expired realtime session token");
      return true;
    }
    // Offer credentials are single-use so a captured browser request cannot join twice.
    pendingOffers.delete(token);
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
    let reservationTransferred = false;
    let responseDeliveryWaiter: ResponseDeliveryWaiter | undefined;
    try {
      const sdp = await readRequestBodyWithLimit(req, {
        maxBytes: OPENAI_QUICKSILVER_MAX_SDP_BYTES,
        timeoutMs: 15_000,
      });
      if (!sdp.trim()) {
        respondText(res, 400, "SDP offer is required");
        return true;
      }
      const upstreamSignal = AbortSignal.any([
        lifecycleSignal,
        AbortSignal.timeout(OPENAI_QUICKSILVER_UPSTREAM_TIMEOUT_MS),
      ]);
      const call = await createOpenAIQuicksilverCall({
        auth: offer.auth,
        requestIds: offer.requestIds,
        sdp,
        session: buildOpenAIQuicksilverSession({
          model: offer.request.model,
          instructions: offer.request.instructions,
          voice: offer.request.voice,
          initialItems: offer.request.initialItems,
        }),
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
      const timer = setTimeout(() => {
        const active = activeSessions.get(token);
        if (active) {
          closeSession(active);
        }
      }, OPENAI_QUICKSILVER_SESSION_TTL_MS);
      timer.unref?.();
      session = {
        abortController,
        socket: connected.socket,
        timer,
        token,
        transcript: [],
        partialTranscriptRole: undefined,
      };
      activeSessions.set(token, session);
      reserveOpenAIQuicksilverSession(token);
      reservationTransferred = true;
      attachSidebandHandlers(session, runAgentConsult);
      const terminalEvent = connected.detachBuffer();
      for (const frame of connected.bufferedFrames) {
        handleSidebandFrame(session, frame.data, frame.isBinary, runAgentConsult);
      }
      if (terminalEvent && activeSessions.get(token) === session) {
        if (terminalEvent.kind === "error") {
          params.logger.warn(
            `OpenAI GPT-Live sideband socket failed: ${terminalEvent.error.message}`,
          );
          closeSession(session);
        } else {
          finalizeSession(session);
        }
      }
      if (activeSessions.get(token) !== session) {
        throw new Error("OpenAI GPT-Live sideband failed during startup");
      }

      responseDeliveryWaiter = createResponseDeliveryWaiter(res, detachBrowserAbort);
      res.statusCode = 200;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/sdp");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(call.answerSdp);
      const delivered = await responseDeliveryWaiter.result;
      responseDeliveryWaiter = undefined;
      if (!delivered || lifecycleSignal.aborted) {
        closeSession(session);
      }
      return true;
    } catch (error) {
      if (session) {
        closeSession(session);
      }
      if (browserDisconnected) {
        return true;
      }
      respondText(
        res,
        502,
        error instanceof Error ? error.message : "OpenAI GPT-Live session failed",
      );
      return true;
    } finally {
      responseDeliveryWaiter?.cancel();
      detachBrowserAbort();
      inFlightOffers.delete(token);
      if (!reservationTransferred) {
        reservations.delete(token);
        releaseOpenAIQuicksilverSession(token);
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
    shutdownController.abort(new Error("OpenAI GPT-Live broker stopped"));
    pendingOffers.clear();
    for (const controller of inFlightOffers.values()) {
      controller.abort(new Error("OpenAI GPT-Live broker stopped"));
    }
    for (const session of activeSessions.values()) {
      closeSession(session);
    }
    await Promise.allSettled(inFlightHandlers);
    for (const token of reservations) {
      releaseOpenAIQuicksilverSession(token);
    }
    reservations.clear();
  };

  return { broker, handler, cleanup };
}
