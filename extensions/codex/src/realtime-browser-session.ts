// Experimental ChatGPT OAuth browser session broker for Control UI realtime Talk.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type {
  RealtimeVoiceBrowserSessionBroker,
  RealtimeVoiceBrowserSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-voice";
import { getRealtimeVoiceBrowserSessionBroker } from "openclaw/plugin-sdk/realtime-voice";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./app-server/attempt-client-cleanup.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import { readCodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { assertCodexThreadStartResponse } from "./app-server/protocol-validators.js";
import type { CodexThreadStartParams } from "./app-server/protocol.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";

const CODEX_REALTIME_OFFER_PATH = "/plugins/codex/realtime/calls";
const CODEX_REALTIME_PENDING_TTL_MS = 60_000;
const CODEX_REALTIME_SESSION_TTL_MS = 30 * 60_000;
const CODEX_REALTIME_MAX_SESSIONS = 8;
const CODEX_REALTIME_MAX_SDP_BYTES = 256 * 1024;
const CODEX_REALTIME_START_TIMEOUT_MS = 60_000;
const CODEX_REALTIME_OFFER_HANDLER = Symbol.for("openclaw.codexRealtimeOfferHandler");

type PendingOffer = {
  expiresAt: number;
  request: RealtimeVoiceBrowserSessionCreateRequest;
};

type ActiveSession = {
  client: CodexAppServerClient;
  reservationToken: string;
  threadId: string;
  timer: NodeJS.Timeout;
  disposeNotificationHandler: () => void;
};

type RealtimeNotificationParams = {
  threadId?: unknown;
  sdp?: unknown;
  message?: unknown;
};

type CodexRealtimeBrowserSessionBroker = RealtimeVoiceBrowserSessionBroker & {
  [CODEX_REALTIME_OFFER_HANDLER]?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
};

type ResponseDeliveryWaiter = {
  result: Promise<boolean>;
  cancel: () => void;
};

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
    // ServerResponse may emit close immediately after finish. Remove the
    // disconnect abort synchronously so normal completion keeps WebRTC alive.
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

function readBearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization?.trim();
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function readNotificationParams(value: unknown): RealtimeNotificationParams {
  return value && typeof value === "object" ? (value as RealtimeNotificationParams) : {};
}

function buildCodexRealtimeThreadStartParams(params: { cwd: string }): CodexThreadStartParams {
  return {
    cwd: params.cwd,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: { "features.realtime_conversation": true },
  };
}

function buildCodexRealtimeStartParams(params: {
  threadId: string;
  sdp: string;
  developerInstructions?: string;
  voice?: string;
  initialItems?: RealtimeVoiceBrowserSessionCreateRequest["initialItems"];
}): Record<string, unknown> {
  const initialItems = [
    ...(params.developerInstructions
      ? [{ role: "developer" as const, text: params.developerInstructions }]
      : []),
    ...(params.initialItems ?? []),
  ];
  return {
    threadId: params.threadId,
    outputModality: "audio",
    transport: { type: "webrtc", sdp: params.sdp },
    version: "v3",
    includeStartupContext: true,
    ...(params.voice ? { voice: params.voice } : {}),
    ...(initialItems.length > 0 ? { initialItems } : {}),
  };
}

function waitForRealtimeSdpAnswer(
  answerPromise: Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (result: { answer: string } | { error: Error }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if ("answer" in result) {
        resolve(result.answer);
      } else {
        reject(result.error);
      }
    };
    const onAbort = () =>
      finish({ error: new Error("Codex realtime session stopped during startup") });
    const timeout = setTimeout(
      () => finish({ error: new Error("Codex realtime SDP answer timed out") }),
      CODEX_REALTIME_START_TIMEOUT_MS,
    );
    timeout.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void answerPromise.then(
      (answer) => finish({ answer }),
      (error: unknown) =>
        finish({ error: error instanceof Error ? error : new Error("Codex realtime failed") }),
    );
  });
}

export function createCodexRealtimeBrowserSessionBroker(params: {
  getPluginConfig: () => unknown;
}): {
  broker: RealtimeVoiceBrowserSessionBroker;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  cleanup: () => Promise<void>;
} {
  const pendingOffers = new Map<string, PendingOffer>();
  const reservations = new Set<string>();
  const activeSessions = new Set<ActiveSession>();
  const inFlightHandlers = new Set<Promise<boolean>>();
  const shutdownController = new AbortController();
  let cleanedUp = false;

  const prunePendingOffers = () => {
    const now = Date.now();
    for (const [token, offer] of pendingOffers) {
      if (offer.expiresAt <= now) {
        pendingOffers.delete(token);
        reservations.delete(token);
      }
    }
  };

  const closeSession = async (session: ActiveSession) => {
    if (!activeSessions.delete(session)) {
      return;
    }
    clearTimeout(session.timer);
    reservations.delete(session.reservationToken);
    session.disposeNotificationHandler();
    try {
      await session.client.request(
        "thread/realtime/stop",
        { threadId: session.threadId },
        { timeoutMs: 2_000 },
      );
    } catch {
      // The peer or app-server may already have closed the realtime transport.
    }
    await unsubscribeCodexThreadBestEffort(session.client, {
      threadId: session.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    releaseLeasedSharedCodexAppServerClient(session.client);
  };

  const broker: RealtimeVoiceBrowserSessionBroker = {
    id: "codex-oauth",
    providerId: "openai",
    capabilities: {
      transports: ["webrtc"],
      handlesAgentConsult: true,
      supportsToolCalls: false,
      supportsVideoFrames: false,
    },
    // Native ChatGPT login state belongs to Codex and is verified by app-server;
    // OpenClaw never reads or copies its OAuth token.
    isConfigured: () => true,
    createBrowserSession: async (request: RealtimeVoiceBrowserSessionCreateRequest) => {
      if (cleanedUp || shutdownController.signal.aborted) {
        throw new Error("Codex OAuth realtime is stopping; restart Gateway and try again");
      }
      prunePendingOffers();
      if (reservations.size >= CODEX_REALTIME_MAX_SESSIONS) {
        throw new Error("Too many concurrent Codex OAuth realtime sessions; try again in a minute");
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + CODEX_REALTIME_PENDING_TTL_MS;
      reservations.add(token);
      pendingOffers.set(token, { expiresAt, request });
      const voice = request.voice?.trim() || undefined;
      return {
        provider: "openai",
        transport: "webrtc",
        clientSecret: token,
        offerUrl: CODEX_REALTIME_OFFER_PATH,
        ...(voice ? { voice } : {}),
        expiresAt,
      };
    },
    cancelBrowserSession: (session) => {
      if (session.transport !== "webrtc") {
        return;
      }
      pendingOffers.delete(session.clientSecret);
      reservations.delete(session.clientSecret);
    },
  };

  const handleOffer = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
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
    // A browser session token is single-use so captured requests cannot be replayed.
    pendingOffers.delete(token);
    const requestController = new AbortController();
    const abortFromBrowser = () => {
      requestController.abort(new Error("Browser realtime offer request closed"));
    };
    req.once("aborted", abortFromBrowser);
    res.once("close", abortFromBrowser);
    const detachBrowserAbort = () => {
      req.removeListener("aborted", abortFromBrowser);
      res.removeListener("close", abortFromBrowser);
    };
    const lifecycleSignal = AbortSignal.any([shutdownController.signal, requestController.signal]);

    let client: CodexAppServerClient | undefined;
    let session: ActiveSession | undefined;
    let threadId: string | undefined;
    let reservationTransferred = false;
    let responseDeliveryWaiter: ResponseDeliveryWaiter | undefined;
    try {
      const sdp = await readRequestBodyWithLimit(req, {
        maxBytes: CODEX_REALTIME_MAX_SDP_BYTES,
        timeoutMs: 15_000,
      });
      if (!sdp.trim()) {
        respondText(res, 400, "SDP offer is required");
        return true;
      }
      if (lifecycleSignal.aborted) {
        throw new Error("Codex realtime session stopped during startup");
      }

      const pluginConfig = readCodexPluginConfig(params.getPluginConfig());
      const agentDir =
        offer.request.agentId && offer.request.cfg
          ? resolveAgentDir(offer.request.cfg, offer.request.agentId)
          : undefined;
      const runtime = resolveCodexAppServerRuntimeOptions({
        pluginConfig,
        config: offer.request.cfg,
        agentDir,
      });
      // Share the agent's normal Codex app-server process. A fresh ephemeral thread
      // keeps realtime from replacing a live normal turn on the bound Codex thread.
      client = await getLeasedSharedCodexAppServerClient({
        startOptions: runtime.start,
        pluginConfig,
        config: offer.request.cfg,
        agentDir,
        authRequirement: "subscription",
        timeoutMs: CODEX_REALTIME_START_TIMEOUT_MS,
        abandonSignal: lifecycleSignal,
      });

      const started = assertCodexThreadStartResponse(
        await client.request(
          "thread/start",
          buildCodexRealtimeThreadStartParams({
            cwd: offer.request.workspaceDir ?? process.cwd(),
          }),
          { timeoutMs: CODEX_REALTIME_START_TIMEOUT_MS, signal: lifecycleSignal },
        ),
      );
      threadId = started.thread.id;
      if (lifecycleSignal.aborted) {
        throw new Error("Codex realtime session stopped during startup");
      }

      let resolveSdp!: (answer: string) => void;
      let rejectSdp!: (error: Error) => void;
      const answerPromise = new Promise<string>((resolve, reject) => {
        resolveSdp = resolve;
        rejectSdp = reject;
      });
      const disposeNotificationHandler = client.addNotificationHandler((notification) => {
        const notificationParams = readNotificationParams(notification.params);
        if (notificationParams.threadId !== threadId) {
          return;
        }
        if (notification.method === "thread/realtime/sdp") {
          if (typeof notificationParams.sdp === "string" && notificationParams.sdp.trim()) {
            resolveSdp(notificationParams.sdp);
          } else {
            rejectSdp(new Error("Codex returned an empty realtime SDP answer"));
          }
          return;
        }
        if (notification.method === "thread/realtime/error") {
          rejectSdp(
            new Error(
              typeof notificationParams.message === "string"
                ? notificationParams.message
                : "Codex realtime session failed",
            ),
          );
          return;
        }
        if (notification.method === "thread/realtime/closed" && session) {
          rejectSdp(new Error("Codex realtime session closed before returning an SDP answer"));
          void closeSession(session);
        }
      });
      const timer = setTimeout(() => {
        if (session) {
          void closeSession(session);
        }
      }, CODEX_REALTIME_SESSION_TTL_MS);
      timer.unref?.();
      session = {
        client,
        reservationToken: token,
        threadId,
        timer,
        disposeNotificationHandler,
      };
      reservationTransferred = true;
      activeSessions.add(session);

      await client.request(
        "thread/realtime/start",
        buildCodexRealtimeStartParams({
          threadId,
          sdp,
          developerInstructions: offer.request.instructions?.trim() || undefined,
          voice: offer.request.voice?.trim() || undefined,
          initialItems: offer.request.initialItems,
        }),
        { timeoutMs: CODEX_REALTIME_START_TIMEOUT_MS, signal: lifecycleSignal },
      );
      const answer = await waitForRealtimeSdpAnswer(answerPromise, lifecycleSignal);
      responseDeliveryWaiter = createResponseDeliveryWaiter(res, detachBrowserAbort);
      res.statusCode = 200;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/sdp");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(answer);
      const delivered = await responseDeliveryWaiter.result;
      responseDeliveryWaiter = undefined;
      if (!delivered || lifecycleSignal.aborted) {
        await closeSession(session);
      }
      return true;
    } catch (error) {
      if (session) {
        await closeSession(session);
      } else if (client) {
        if (threadId) {
          await unsubscribeCodexThreadBestEffort(client, {
            threadId,
            timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
          });
        }
        releaseLeasedSharedCodexAppServerClient(client);
      }
      if (requestController.signal.aborted) {
        return true;
      }
      const message = error instanceof Error ? error.message : "Codex realtime session failed";
      respondText(res, 502, message);
      return true;
    } finally {
      responseDeliveryWaiter?.cancel();
      detachBrowserAbort();
      if (!reservationTransferred) {
        reservations.delete(token);
      }
    }
  };
  const trackedHandleOffer = (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const handling = handleOffer(req, res);
    inFlightHandlers.add(handling);
    return handling.finally(() => {
      inFlightHandlers.delete(handling);
    });
  };
  (broker as CodexRealtimeBrowserSessionBroker)[CODEX_REALTIME_OFFER_HANDLER] = trackedHandleOffer;

  // Provider discovery can evaluate plugin entries in a separate Jiti context from
  // the Gateway HTTP registry. Always delegate to the currently registered broker
  // so the one-time token and its offer handler share the same closure.
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const activeBroker = getRealtimeVoiceBrowserSessionBroker("openai", "codex-oauth") as
      | CodexRealtimeBrowserSessionBroker
      | undefined;
    const activeHandler = activeBroker?.[CODEX_REALTIME_OFFER_HANDLER];
    if (!activeHandler) {
      respondText(res, 503, "Codex OAuth realtime voice is unavailable");
      return true;
    }
    return await activeHandler(req, res);
  };

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    shutdownController.abort();
    pendingOffers.clear();
    await Promise.all([...activeSessions].map((session) => closeSession(session)));
    await Promise.allSettled(inFlightHandlers);
    reservations.clear();
  };

  return { broker, handler, cleanup };
}

export { CODEX_REALTIME_OFFER_PATH };
