// Experimental ChatGPT OAuth browser session broker for Control UI realtime Talk.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAgentDir, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderCapabilities,
} from "openclaw/plugin-sdk/realtime-voice";
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
  getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";

const CODEX_REALTIME_OFFER_PATH = "/plugins/codex/realtime/calls";
const CODEX_REALTIME_PENDING_TTL_MS = 60_000;
const CODEX_REALTIME_SESSION_TTL_MS = 30 * 60_000;
const CODEX_REALTIME_MAX_SESSIONS = 8;
const CODEX_REALTIME_MAX_SDP_BYTES = 256 * 1024;
const CODEX_REALTIME_START_TIMEOUT_MS = 60_000;
const CODEX_REALTIME_PROBE_COOLDOWN_MS = 1_000;

type CodexRealtimeBrowserSessionCreateRequest = RealtimeVoiceBrowserSessionCreateRequest & {
  agentId?: string;
  workspaceDir?: string;
  initialItems?: Array<{
    role: "user" | "assistant";
    text: string;
  }>;
};

type CodexRealtimeProviderCapabilities = Partial<RealtimeVoiceProviderCapabilities> & {
  handlesAgentConsult?: boolean;
};

type PendingOffer = {
  expiresAt: number;
  request: CodexRealtimeBrowserSessionCreateRequest;
};

export type CodexRealtimeBrowserSessionFallback = {
  capabilities: CodexRealtimeProviderCapabilities;
  isConfigured: () => boolean;
  createBrowserSession: (
    request: CodexRealtimeBrowserSessionCreateRequest,
  ) => Promise<RealtimeVoiceBrowserSession>;
  cancelBrowserSession: (session: RealtimeVoiceBrowserSession) => Promise<void> | void;
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

function resolveConfiguredControlUiOrigin(
  req: IncomingMessage,
  cfg: OpenClawConfig | undefined,
): string | undefined {
  const rawOrigin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (!rawOrigin) {
    return undefined;
  }
  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin || parsed.username || parsed.password) {
      return undefined;
    }
    origin = parsed.origin;
  } catch {
    return undefined;
  }
  const allowed = cfg?.gateway?.controlUi?.allowedOrigins ?? [];
  return allowed.some((candidate) => {
    const normalized = candidate.trim().toLowerCase();
    return normalized === "*" || normalized === origin;
  })
    ? origin
    : undefined;
}

function applyRealtimeOfferCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig | undefined,
): boolean {
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveConfiguredControlUiOrigin(req, cfg);
  if (!origin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
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
  initialItems?: CodexRealtimeBrowserSessionCreateRequest["initialItems"];
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
      finish({
        error:
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Codex realtime session stopped during startup"),
      });
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
  getConfig: () => OpenClawConfig | undefined;
  getPluginConfig: () => unknown;
}): {
  broker: CodexRealtimeBrowserSessionFallback;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  warmup: () => Promise<void>;
  cleanup: () => Promise<void>;
} {
  const pendingOffers = new Map<string, PendingOffer>();
  const reservations = new Set<string>();
  const activeSessions = new Set<ActiveSession>();
  const inFlightHandlers = new Set<Promise<boolean>>();
  const readyClients = new Set<CodexAppServerClient>();
  const shutdownController = new AbortController();
  let cleanedUp = false;
  let probePromise: Promise<void> | undefined;
  let nextProbeAt = 0;

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

  const resolveSubscriptionClientOptions = (request: {
    cfg?: OpenClawConfig;
    agentId?: string;
  }) => {
    const pluginConfig = readCodexPluginConfig(params.getPluginConfig());
    const agentDir =
      request.agentId && request.cfg ? resolveAgentDir(request.cfg, request.agentId) : undefined;
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig,
      config: request.cfg,
      agentDir,
    });
    return {
      startOptions: runtime.start,
      pluginConfig,
      config: request.cfg,
      agentDir,
      authRequirement: "subscription" as const,
      timeoutMs: CODEX_REALTIME_START_TIMEOUT_MS,
    };
  };

  const ensureSubscriptionRuntime = async (request: { cfg?: OpenClawConfig; agentId?: string }) => {
    const client = await getSharedCodexAppServerClient({
      ...resolveSubscriptionClientOptions(request),
      abandonSignal: shutdownController.signal,
    });
    if (!readyClients.has(client)) {
      readyClients.add(client);
      client.addCloseHandler((closedClient) => {
        readyClients.delete(closedClient);
        void Promise.allSettled(
          [...activeSessions]
            .filter((session) => session.client === closedClient)
            .map((session) => closeSession(session)),
        );
        nextProbeAt = 0;
        requestProbe();
      });
    }
  };

  const runProbe = () => {
    if (probePromise) {
      return probePromise;
    }
    const cfg = params.getConfig();
    nextProbeAt = Date.now() + CODEX_REALTIME_PROBE_COOLDOWN_MS;
    const running = ensureSubscriptionRuntime({
      cfg,
      ...(cfg ? { agentId: resolveDefaultAgentId(cfg) } : {}),
    }).finally(() => {
      if (probePromise === running) {
        probePromise = undefined;
      }
    });
    probePromise = running;
    return running;
  };

  function requestProbe(): void {
    if (
      cleanedUp ||
      shutdownController.signal.aborted ||
      probePromise ||
      Date.now() < nextProbeAt
    ) {
      return;
    }
    // Readiness stays false while the async Codex probe runs. This lets auth or
    // process recovery become visible without shadowing another healthy provider.
    void runProbe().catch(() => undefined);
  }

  const warmup = async () => {
    await runProbe();
  };

  const prunePendingOffers = () => {
    const now = Date.now();
    for (const [token, offer] of pendingOffers) {
      if (offer.expiresAt <= now) {
        pendingOffers.delete(token);
        reservations.delete(token);
      }
    }
  };

  const broker: CodexRealtimeBrowserSessionFallback = {
    capabilities: {
      transports: ["webrtc"],
      handlesAgentConsult: true,
      supportsToolCalls: false,
      supportsVideoFrames: false,
    },
    isConfigured: () => {
      if (cleanedUp || shutdownController.signal.aborted) {
        return false;
      }
      if (readyClients.size > 0) {
        return true;
      }
      requestProbe();
      return false;
    },
    createBrowserSession: async (request: CodexRealtimeBrowserSessionCreateRequest) => {
      if (cleanedUp || shutdownController.signal.aborted) {
        throw new Error("Codex OAuth realtime is stopping; restart Gateway and try again");
      }
      // Revalidate the request's exact agent/runtime before the Gateway persists a
      // client voice session. The warmed shared process makes this path cheap.
      await ensureSubscriptionRuntime(request);
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

      // Share the agent's normal Codex app-server process. A fresh ephemeral thread
      // keeps realtime from replacing a live normal turn on the bound Codex thread.
      client = await getLeasedSharedCodexAppServerClient({
        ...resolveSubscriptionClientOptions(offer.request),
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
      const startupController = new AbortController();
      const startupSignal = AbortSignal.any([lifecycleSignal, startupController.signal]);
      let startupComplete = false;
      const stopStartup = (error: Error) => {
        if (!startupController.signal.aborted) {
          startupController.abort(error);
        }
      };
      const closeAfterStartup = () => {
        // During startup the request handler owns ordered cleanup. Once the SDP
        // response is ready, terminal notifications must release the live session.
        if (startupComplete && session) {
          void closeSession(session);
        }
      };
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
          const error = new Error(
            typeof notificationParams.message === "string"
              ? notificationParams.message
              : "Codex realtime session failed",
          );
          rejectSdp(error);
          stopStartup(error);
          closeAfterStartup();
          return;
        }
        if (notification.method === "thread/realtime/closed") {
          const error = new Error("Codex realtime session closed before returning an SDP answer");
          rejectSdp(error);
          stopStartup(error);
          closeAfterStartup();
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

      // Observe the answer before starting the request: Codex may emit a terminal
      // notification before the matching JSON-RPC response reaches this process.
      const answerResultPromise = waitForRealtimeSdpAnswer(answerPromise, startupSignal).then(
        (answer) => ({ ok: true as const, answer }),
        (error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error : new Error("Codex realtime session failed"),
        }),
      );
      try {
        await client.request(
          "thread/realtime/start",
          buildCodexRealtimeStartParams({
            threadId,
            sdp,
            developerInstructions: offer.request.instructions?.trim() || undefined,
            voice: offer.request.voice?.trim() || undefined,
            initialItems: offer.request.initialItems,
          }),
          { timeoutMs: CODEX_REALTIME_START_TIMEOUT_MS, signal: startupSignal },
        );
      } catch (error) {
        if (startupController.signal.aborted) {
          const answerResult = await answerResultPromise;
          if (!answerResult.ok) {
            throw answerResult.error;
          }
          throw startupController.signal.reason instanceof Error
            ? startupController.signal.reason
            : new Error("Codex realtime session stopped during startup");
        }
        stopStartup(
          error instanceof Error ? error : new Error("Codex realtime session failed to start"),
        );
        throw error;
      }
      const answerResult = await answerResultPromise;
      if (!answerResult.ok) {
        throw answerResult.error;
      }
      if (startupSignal.aborted) {
        throw startupSignal.reason instanceof Error
          ? startupSignal.reason
          : new Error("Codex realtime session stopped during startup");
      }
      startupComplete = true;
      responseDeliveryWaiter = createResponseDeliveryWaiter(res, detachBrowserAbort);
      res.statusCode = 200;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-type", "application/sdp");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(answerResult.answer);
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
  const handler = trackedHandleOffer;

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

  return { broker, handler, warmup, cleanup };
}

export { CODEX_REALTIME_OFFER_PATH };
