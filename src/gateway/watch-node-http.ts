// watchOS direct-node transport.
// Apple Watch cannot use generic WebSockets on-device, so node events use bounded HTTPS polls.
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  formatValidationErrors,
  PROTOCOL_VERSION,
  validateConnectParams,
  type ConnectParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getBoundDeviceBootstrapProfile,
  redeemDeviceBootstrapTokenProfile,
  restoreDeviceBootstrapToken,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../infra/device-bootstrap.js";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
} from "../infra/device-identity.js";
import {
  approveBootstrapDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  requestDevicePairing,
  verifyDeviceToken,
} from "../infra/device-pairing.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  finalizeNodePairingCleanupClaim,
  releaseNodePairingCleanupClaim,
  requestNodePairing,
  recordPairedNodeConnection,
  type RequestNodePairingResult,
} from "../infra/node-pairing.js";
import { isNodePairingSetupBootstrapProfile } from "../shared/device-bootstrap-profile.js";
import {
  AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING,
  AUTH_RATE_LIMIT_SCOPE_WATCH_CHALLENGE,
  buildRateLimitIdentityKey,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { hasForwardedRequestHeaders } from "./auth.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendRateLimited,
  sendUnauthorized,
} from "./http-common.js";
import { ADMIN_SCOPE, PAIRING_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import { isLoopbackAddress, resolveRequestClientIp } from "./net.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";
import type { NodeReapprovalCoordinator } from "./node-reapproval-coordinator.js";
import type {
  NodeConnectivityResult,
  NodeEventTransport,
  NodeRegistry,
  NodeSession,
  SerializedEventPayload,
} from "./node-registry.js";
import { withSerializedRateLimitAttempt } from "./rate-limit-attempt-serialization.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { resolveConnectAuthDecision } from "./server/ws-connection/auth-context.js";
import { resolveDeviceSignaturePayloadVersion } from "./server/ws-connection/handshake-auth-helpers.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const BASE_PATH = "/api/nodes/watch";
const CONNECT_PATH = `${BASE_PATH}/connect`;
const CHALLENGE_PATH = `${BASE_PATH}/challenge`;
const DISCONNECT_PATH = `${BASE_PATH}/disconnect`;
const POLL_PATH = `${BASE_PATH}/poll`;
const RESULT_PATH = `${BASE_PATH}/result`;
const CHALLENGE_TTL_MS = 60_000;
const SIGNATURE_SKEW_MS = 2 * 60_000;
const POLL_TIMEOUT_MS = 20_000;
const SESSION_IDLE_MS = 75_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUED_EVENT_BYTES = 64 * 1024;
const MAX_QUEUED_BYTES = 512 * 1024;
const MAX_QUEUED_EVENTS = 32;
const MAX_PENDING_CHALLENGES = 4_096;
const MAX_PENDING_CHALLENGES_PER_CLIENT = 8;
const WATCH_CAPS = new Set<string>();
const WATCH_COMMANDS = new Set(["device.info", "device.status", "system.notify"]);
const WATCH_PERMISSIONS = new Set(["notifications"]);

type QueuedNodeEvent = { json: string; byteLength: number };

type PendingChallenge = { clientKey: string; expiresAtMs: number };

type ResponseLifecycle = {
  completed: Promise<boolean>;
  isAborted: () => boolean;
};

type WatchNodeSession = {
  token: string;
  nodeId: string;
  connId: string;
  invalidatedReason?: string;
  lastSeenAtMs: number;
  expiresTimer: ReturnType<typeof setTimeout>;
  queue: QueuedNodeEvent[];
  queuedBytes: number;
  waiter?: {
    res: ServerResponse;
    timer: ReturnType<typeof setTimeout>;
  };
};

type WatchNodeHttpRuntimeOptions = {
  nodeRegistry: NodeRegistry;
  getConfig: () => OpenClawConfig;
  broadcast: GatewayBroadcastFn;
  rateLimiter?: AuthRateLimiter;
  nodeReapprovalCoordinator?: NodeReapprovalCoordinator;
  onNodeConnected?: (session: NodeSession) => void;
  onNodeDisconnected?: (nodeId: string, reason: string) => void;
  onError?: (message: string, error: unknown) => void;
  pairingBaseDir?: string;
  now?: () => number;
};

class WatchNodePairingRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("watch node pairing rate limited");
  }
}

function normalizePath(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

function readBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

function resolveWatchClientAddress(
  req: IncomingMessage,
  config: OpenClawConfig,
): { clientIp?: string; rateLimitKey: string } {
  const trustedProxies = config.gateway?.trustedProxies ?? [];
  const clientIp = resolveRequestClientIp(
    req,
    trustedProxies,
    config.gateway?.allowRealIpFallback === true,
  );
  if (hasForwardedRequestHeaders(req) && isLoopbackAddress(clientIp)) {
    // Untrusted loopback proxies must not inherit the limiter's localhost exemption.
    return {
      rateLimitKey: buildRateLimitIdentityKey("watch-proxy", req.socket.remoteAddress ?? "unknown"),
    };
  }
  return {
    ...(clientIp ? { clientIp } : {}),
    rateLimitKey: clientIp ?? buildRateLimitIdentityKey("watch-client", "unknown"),
  };
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trackResponseLifecycle(res: ServerResponse): ResponseLifecycle {
  let aborted = false;
  let settled = false;
  let resolveCompleted: (completed: boolean) => void = () => undefined;
  const completed = new Promise<boolean>((resolve) => {
    resolveCompleted = resolve;
  });
  const settle = (value: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    res.off("finish", onFinish);
    res.off("close", onClose);
    resolveCompleted(value);
  };
  const onFinish = () => settle(true);
  const onClose = () => {
    aborted = !res.writableFinished;
    settle(!aborted);
  };
  res.once("finish", onFinish);
  res.once("close", onClose);
  return { completed, isAborted: () => aborted };
}

function hasOnlyBoundedWatchSurface(connect: ConnectParams): boolean {
  const caps = Array.isArray(connect.caps) ? connect.caps : [];
  const commands = Array.isArray(connect.commands) ? connect.commands : [];
  const permissionEntries = Object.entries(connect.permissions ?? {});
  return (
    caps.every((cap) => WATCH_CAPS.has(cap)) &&
    commands.length > 0 &&
    commands.every((command) => WATCH_COMMANDS.has(command)) &&
    permissionEntries.every(([permission]) => WATCH_PERMISSIONS.has(permission))
  );
}

function isCanonicalWatchNode(connect: ConnectParams): boolean {
  const platform = connect.client.platform.trim().toLowerCase();
  const family = connect.client.deviceFamily?.trim().toLowerCase();
  return (
    connect.minProtocol <= PROTOCOL_VERSION &&
    connect.maxProtocol >= PROTOCOL_VERSION &&
    connect.role === "node" &&
    (connect.scopes?.length ?? 0) === 0 &&
    connect.client.id === GATEWAY_CLIENT_IDS.WATCHOS_APP &&
    connect.client.mode === GATEWAY_CLIENT_MODES.NODE &&
    platform.startsWith("watchos") &&
    family === "apple watch" &&
    hasOnlyBoundedWatchSurface(connect)
  );
}

function createChallengeStore() {
  const challenges = new Map<string, PendingChallenge>();

  const pruneExpired = (current: number) => {
    for (const [nonce, challenge] of challenges) {
      if (challenge.expiresAtMs <= current) {
        challenges.delete(nonce);
      }
    }
  };

  return {
    issue: (clientKey: string, current: number) => {
      pruneExpired(current);
      const clientNonces = [...challenges.entries()].filter(
        ([, challenge]) => challenge.clientKey === clientKey,
      );
      while (clientNonces.length >= MAX_PENDING_CHALLENGES_PER_CLIENT) {
        const oldest = clientNonces.shift();
        if (oldest) {
          challenges.delete(oldest[0]);
        }
      }
      while (challenges.size >= MAX_PENDING_CHALLENGES) {
        const oldest = challenges.keys().next().value;
        if (typeof oldest !== "string") {
          break;
        }
        challenges.delete(oldest);
      }
      const nonce = randomBytes(24).toString("base64url");
      const expiresAtMs = current + CHALLENGE_TTL_MS;
      challenges.set(nonce, { clientKey, expiresAtMs });
      return { nonce, expiresAtMs };
    },
    consume: (nonce: string, clientKey: string, current: number) => {
      const challenge = challenges.get(nonce);
      challenges.delete(nonce);
      return Boolean(
        challenge && challenge.clientKey === clientKey && challenge.expiresAtMs > current,
      );
    },
    clear: () => challenges.clear(),
  };
}

function broadcastPairingSuperseded(
  broadcast: GatewayBroadcastFn,
  result: RequestNodePairingResult,
  now: number,
) {
  for (const superseded of result.created ? (result.superseded ?? []) : []) {
    broadcast(
      "node.pair.resolved",
      {
        requestId: superseded.requestId,
        nodeId: superseded.nodeId,
        decision: "rejected",
        ts: now,
      },
      { dropIfSlow: true },
    );
  }
}

/** Create the first-party watchOS node HTTP transport for one Gateway process. */
export function createWatchNodeHttpRuntime(options: WatchNodeHttpRuntimeOptions): {
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  invalidateSessionsForDevice: (
    deviceId: string,
    opts?: { role?: string; reason?: string },
  ) => void;
  disconnectSessionsForDevice: (deviceId: string, opts?: { role?: string }) => void;
  close: () => void;
} {
  const now = options.now ?? Date.now;
  const challenges = createChallengeStore();
  const sessionsByToken = new Map<string, WatchNodeSession>();
  const sessionsByNodeId = new Map<string, WatchNodeSession>();
  let closed = false;

  const closeSession = (session: WatchNodeSession, reason: string) => {
    if (sessionsByToken.get(session.token) !== session) {
      return;
    }
    sessionsByToken.delete(session.token);
    if (sessionsByNodeId.get(session.nodeId) === session) {
      sessionsByNodeId.delete(session.nodeId);
    }
    clearTimeout(session.expiresTimer);
    if (session.waiter) {
      clearTimeout(session.waiter.timer);
      if (!session.waiter.res.writableEnded) {
        sendJson(session.waiter.res, 401, { ok: false, reason });
      }
      session.waiter = undefined;
    }
    const disconnectedNodeId = options.nodeRegistry.unregister(session.connId);
    if (disconnectedNodeId) {
      try {
        options.onNodeDisconnected?.(disconnectedNodeId, reason);
      } catch (error) {
        options.onError?.("watch node disconnect cleanup failed", error);
      }
    }
  };

  const armExpiry = (session: WatchNodeSession) => {
    clearTimeout(session.expiresTimer);
    session.expiresTimer = setTimeout(
      () => closeSession(session, "session expired"),
      SESSION_IDLE_MS,
    );
    session.expiresTimer.unref?.();
  };

  const touchSession = (session: WatchNodeSession) => {
    session.lastSeenAtMs = now();
    armExpiry(session);
  };

  const sendQueuedEvent = (res: ServerResponse, queued: QueuedNodeEvent): boolean => {
    if (res.writableEnded) {
      return false;
    }
    try {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(`{"ok":true,"event":${queued.json}}`);
      return true;
    } catch {
      return false;
    }
  };

  const enqueue = (session: WatchNodeSession, queued: QueuedNodeEvent | null): boolean => {
    if (sessionsByToken.get(session.token) !== session || session.invalidatedReason) {
      return false;
    }
    if (!queued || queued.byteLength > MAX_QUEUED_EVENT_BYTES) {
      closeSession(session, "event payload too large");
      return false;
    }
    if (session.waiter) {
      const waiter = session.waiter;
      session.waiter = undefined;
      clearTimeout(waiter.timer);
      if (!sendQueuedEvent(waiter.res, queued)) {
        closeSession(session, "event delivery failed");
        return false;
      }
      return true;
    }
    if (
      session.queue.length >= MAX_QUEUED_EVENTS ||
      session.queuedBytes + queued.byteLength > MAX_QUEUED_BYTES
    ) {
      closeSession(session, "event queue overflow");
      return false;
    }
    session.queue.push(queued);
    session.queuedBytes += queued.byteLength;
    return true;
  };

  const serializeEvent = (event: string, payload?: unknown): QueuedNodeEvent | null => {
    try {
      const json = JSON.stringify({ event, ...(payload === undefined ? {} : { payload }) });
      return { json, byteLength: Buffer.byteLength(json) };
    } catch {
      return null;
    }
  };

  const serializeRawEvent = (
    event: string,
    payloadJSON?: SerializedEventPayload | null,
  ): QueuedNodeEvent | null => {
    const eventJSON = JSON.stringify(event);
    if (!payloadJSON) {
      const json = `{"event":${eventJSON}}`;
      return { json, byteLength: Buffer.byteLength(json) };
    }
    const prefix = `{"event":${eventJSON},"payload":`;
    const byteLength =
      Buffer.byteLength(prefix) + Buffer.byteLength(payloadJSON.json) + Buffer.byteLength("}");
    if (byteLength > MAX_QUEUED_EVENT_BYTES) {
      return null;
    }
    return { json: `${prefix}${payloadJSON.json}}`, byteLength };
  };

  const createTransport = (session: WatchNodeSession): NodeEventTransport => ({
    send: (event, payload) => enqueue(session, serializeEvent(event, payload)),
    sendRaw: (event, payloadJSON: SerializedEventPayload | null | undefined) =>
      enqueue(session, serializeRawEvent(event, payloadJSON)),
    checkConnectivity: async (): Promise<NodeConnectivityResult> => {
      if (session.invalidatedReason) {
        return {
          ok: false,
          error: { code: "NOT_CONNECTED", message: session.invalidatedReason },
        };
      }
      return now() - session.lastSeenAtMs < SESSION_IDLE_MS
        ? { ok: true }
        : { ok: false, error: { code: "NOT_CONNECTED", message: "watch node poll expired" } };
    },
  });

  const getSession = (req: IncomingMessage, res: ServerResponse): WatchNodeSession | null => {
    const token = readBearerToken(req);
    const session = token ? sessionsByToken.get(token) : undefined;
    if (!session) {
      sendUnauthorized(res);
      return null;
    }
    if (session.invalidatedReason) {
      closeSession(session, session.invalidatedReason);
      sendUnauthorized(res);
      return null;
    }
    touchSession(session);
    return session;
  };

  const handleChallenge = (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "GET").toUpperCase() !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return;
    }
    const { rateLimitKey: clientKey } = resolveWatchClientAddress(req, options.getConfig());
    const rateLimit = options.rateLimiter?.check(clientKey, AUTH_RATE_LIMIT_SCOPE_WATCH_CHALLENGE);
    if (rateLimit && !rateLimit.allowed) {
      sendRateLimited(res, rateLimit.retryAfterMs);
      return;
    }
    options.rateLimiter?.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_WATCH_CHALLENGE);
    const challenge = challenges.issue(clientKey, now());
    res.setHeader("Cache-Control", "no-store");
    sendJson(res, 200, { ok: true, ...challenge });
  };

  const handleConnect = async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }
    const responseLifecycle = trackResponseLifecycle(res);
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return;
    }
    if (!validateConnectParams(body)) {
      sendInvalidRequest(
        res,
        `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`,
      );
      return;
    }
    const connect = body as ConnectParams;
    if (!isCanonicalWatchNode(connect)) {
      sendInvalidRequest(res, "unsupported watch node identity or capability surface");
      return;
    }
    const auth = connect.auth;
    const bootstrapToken = auth?.bootstrapToken?.trim() || null;
    const deviceToken = auth?.deviceToken?.trim() || null;
    const expectedAuthField = bootstrapToken
      ? "bootstrapToken"
      : deviceToken
        ? "deviceToken"
        : null;
    const authFields = Object.keys(auth ?? {});
    if (
      !expectedAuthField ||
      authFields.length !== 1 ||
      authFields[0] !== expectedAuthField ||
      !connect.device
    ) {
      sendUnauthorized(res);
      return;
    }

    const current = now();
    const { clientIp, rateLimitKey: clientKey } = resolveWatchClientAddress(
      req,
      options.getConfig(),
    );
    if (
      !challenges.consume(connect.device.nonce, clientKey, current) ||
      Math.abs(current - connect.device.signedAt) > SIGNATURE_SKEW_MS
    ) {
      sendUnauthorized(res);
      return;
    }
    const publicKey = normalizeDevicePublicKeyBase64Url(connect.device.publicKey);
    const derivedDeviceId = publicKey ? deriveDeviceIdFromPublicKey(publicKey) : null;
    if (!publicKey || !derivedDeviceId || derivedDeviceId !== connect.device.id) {
      sendUnauthorized(res);
      return;
    }
    const signatureVersion = resolveDeviceSignaturePayloadVersion({
      device: { ...connect.device, publicKey },
      connectParams: connect,
      role: "node",
      scopes: [],
      signedAtMs: connect.device.signedAt,
      nonce: connect.device.nonce,
    });
    if (!signatureVersion) {
      sendUnauthorized(res);
      return;
    }

    const authDecision = await resolveConnectAuthDecision({
      state: {
        authResult: { ok: false, reason: "token_mismatch" },
        authOk: false,
        authMethod: "token",
        sharedAuthOk: false,
        sharedAuthProvided: false,
        ...(bootstrapToken ? { bootstrapTokenCandidate: bootstrapToken } : {}),
        ...(deviceToken
          ? {
              deviceTokenCandidate: deviceToken,
              deviceTokenCandidateSource: "explicit-device-token" as const,
            }
          : {}),
      },
      hasDeviceIdentity: true,
      deviceId: derivedDeviceId,
      publicKey,
      role: "node",
      scopes: [],
      rateLimiter: options.rateLimiter,
      clientIp: clientKey,
      verifyBootstrapToken: async (params) =>
        await verifyDeviceBootstrapToken({ ...params, baseDir: options.pairingBaseDir }),
      verifyDeviceToken: async (params) =>
        await verifyDeviceToken({ ...params, baseDir: options.pairingBaseDir }),
    });
    if (!authDecision.authOk) {
      if (authDecision.authResult.rateLimited) {
        sendRateLimited(res, authDecision.authResult.retryAfterMs ?? 0);
      } else {
        sendUnauthorized(res);
      }
      return;
    }

    let issuedDeviceToken = deviceToken;
    let setupBootstrapAccepted = false;
    if (bootstrapToken) {
      const existing = await getPairedDevice(derivedDeviceId, options.pairingBaseDir);
      if (existing && existing.publicKey !== publicKey) {
        sendUnauthorized(res);
        return;
      }
      const profile = await getBoundDeviceBootstrapProfile({
        token: bootstrapToken,
        deviceId: derivedDeviceId,
        publicKey,
        baseDir: options.pairingBaseDir,
      });
      if (!profile || !isNodePairingSetupBootstrapProfile(profile)) {
        sendUnauthorized(res);
        return;
      }
      if (existing) {
        issuedDeviceToken =
          (
            await ensureDeviceToken({
              deviceId: derivedDeviceId,
              role: "node",
              scopes: [],
              baseDir: options.pairingBaseDir,
            })
          )?.token ?? null;
      }
      if (!issuedDeviceToken) {
        const pairing = await requestDevicePairing(
          {
            deviceId: derivedDeviceId,
            publicKey,
            displayName: connect.client.displayName,
            platform: connect.client.platform,
            deviceFamily: connect.client.deviceFamily,
            clientId: connect.client.id,
            clientMode: connect.client.mode,
            role: "node",
            roles: ["node"],
            scopes: [],
            remoteIp: clientIp,
            silent: true,
          },
          options.pairingBaseDir,
        );
        const approved = await approveBootstrapDevicePairing(
          pairing.request.requestId,
          profile,
          options.pairingBaseDir,
        );
        if (approved?.status !== "approved") {
          sendUnauthorized(res);
          return;
        }
        issuedDeviceToken = approved.device.tokens?.node?.token ?? null;
        options.broadcast(
          "device.pair.resolved",
          {
            requestId: pairing.request.requestId,
            deviceId: derivedDeviceId,
            decision: "approved",
            ts: current,
          },
          { dropIfSlow: true },
        );
      }
      setupBootstrapAccepted = Boolean(issuedDeviceToken);
    } else if (deviceToken) {
      const paired = await getPairedDevice(derivedDeviceId, options.pairingBaseDir);
      if (paired?.publicKey !== publicKey) {
        sendUnauthorized(res);
        return;
      }
    }
    if (!issuedDeviceToken) {
      sendUnauthorized(res);
      return;
    }

    const nodeSnapshot = await beginNodePairingConnect(derivedDeviceId, options.pairingBaseDir);
    let cleanupClaim = nodeSnapshot.cleanupClaim;
    try {
      let reconciliation: Awaited<ReturnType<typeof reconcileNodePairingOnConnect>>;
      try {
        reconciliation = await reconcileNodePairingOnConnect({
          cfg: options.getConfig(),
          connectParams: connect,
          pairedNode: nodeSnapshot.pairedNode,
          reportedClientIp: clientIp,
          requestPairing: async (input) => {
            if (nodeSnapshot.pairedNode && options.nodeReapprovalCoordinator) {
              return await options.nodeReapprovalCoordinator.request({
                input,
                cleanupClaim,
                baseDir: options.pairingBaseDir,
              });
            }
            if (!options.rateLimiter) {
              return await requestNodePairing(input, options.pairingBaseDir);
            }
            return await withSerializedRateLimitAttempt({
              ip: clientKey,
              scope: AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING,
              run: async () => {
                const rateCheck = options.rateLimiter?.check(
                  clientKey,
                  AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING,
                );
                if (rateCheck && !rateCheck.allowed) {
                  throw new WatchNodePairingRateLimitError(rateCheck.retryAfterMs);
                }
                const result = await requestNodePairing(input, options.pairingBaseDir);
                options.rateLimiter?.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING);
                return result;
              },
            });
          },
        });
      } catch (error) {
        if (error instanceof WatchNodePairingRateLimitError) {
          sendRateLimited(res, error.retryAfterMs);
          return;
        }
        throw error;
      }
      if (reconciliation.pendingPairing) {
        broadcastPairingSuperseded(options.broadcast, reconciliation.pendingPairing, current);
      }
      if (
        setupBootstrapAccepted &&
        !nodeSnapshot.pairedNode &&
        reconciliation.pendingPairing &&
        hasOnlyBoundedWatchSurface(connect)
      ) {
        const approved = await approveNodePairing(
          reconciliation.pendingPairing.request.requestId,
          { callerScopes: [ADMIN_SCOPE, PAIRING_SCOPE, WRITE_SCOPE] },
          options.pairingBaseDir,
        );
        if (approved && "node" in approved) {
          options.broadcast(
            "node.pair.resolved",
            {
              requestId: reconciliation.pendingPairing.request.requestId,
              nodeId: derivedDeviceId,
              decision: "approved",
              ts: current,
            },
            { dropIfSlow: true },
          );
          reconciliation = {
            ...reconciliation,
            effectiveCaps: reconciliation.declaredCaps,
            effectiveCommands: reconciliation.declaredCommands,
            effectivePermissions: reconciliation.declaredPermissions,
            pendingPairing: undefined,
            shouldClearPendingPairings: true,
          };
        }
      }
      if (reconciliation.pendingPairing?.created) {
        options.broadcast("node.pair.requested", reconciliation.pendingPairing.request, {
          dropIfSlow: true,
        });
      }

      let revokedBootstrapTokenRecord:
        | Awaited<ReturnType<typeof revokeDeviceBootstrapToken>>["record"]
        | undefined;
      if (closed || responseLifecycle.isAborted()) {
        return;
      }
      if (bootstrapToken) {
        const redemption = await redeemDeviceBootstrapTokenProfile({
          token: bootstrapToken,
          role: "node",
          scopes: [],
          baseDir: options.pairingBaseDir,
        });
        if (!redemption.recorded || !redemption.fullyRedeemed) {
          sendUnauthorized(res);
          return;
        }
        const revoked = await revokeDeviceBootstrapToken({
          token: bootstrapToken,
          baseDir: options.pairingBaseDir,
        });
        if (!revoked.removed || !revoked.record) {
          sendUnauthorized(res);
          return;
        }
        revokedBootstrapTokenRecord = revoked.record;
      }

      // Device lifecycle mutations run asynchronously after marking current sessions.
      // Reverify after every pairing await, then publish without another yield so a
      // concurrent revoke either fails admission or sees this registered transport.
      let finalTokenVerification: Awaited<ReturnType<typeof verifyDeviceToken>>;
      try {
        finalTokenVerification = await verifyDeviceToken({
          deviceId: derivedDeviceId,
          token: issuedDeviceToken,
          role: "node",
          scopes: [],
          baseDir: options.pairingBaseDir,
        });
      } catch (error) {
        if (revokedBootstrapTokenRecord) {
          await restoreDeviceBootstrapToken({
            record: revokedBootstrapTokenRecord,
            baseDir: options.pairingBaseDir,
          });
        }
        throw error;
      }
      if (!finalTokenVerification.ok) {
        sendUnauthorized(res);
        return;
      }
      if (closed || responseLifecycle.isAborted()) {
        if (revokedBootstrapTokenRecord) {
          await restoreDeviceBootstrapToken({
            record: revokedBootstrapTokenRecord,
            baseDir: options.pairingBaseDir,
          });
        }
        return;
      }

      const registeredConnect = connect as ConnectParams & {
        declaredCaps?: string[];
        declaredCommands?: string[];
        declaredPermissions?: Record<string, boolean>;
      };
      registeredConnect.declaredCaps = reconciliation.declaredCaps;
      registeredConnect.declaredCommands = reconciliation.declaredCommands;
      registeredConnect.declaredPermissions = reconciliation.declaredPermissions;
      registeredConnect.caps = reconciliation.effectiveCaps;
      registeredConnect.commands = reconciliation.effectiveCommands;
      registeredConnect.permissions = reconciliation.effectivePermissions;

      let session: WatchNodeSession | undefined;
      try {
        const previous = sessionsByNodeId.get(derivedDeviceId);
        const connId = randomUUID();
        session = {
          token: randomBytes(32).toString("base64url"),
          nodeId: derivedDeviceId,
          connId,
          lastSeenAtMs: now(),
          expiresTimer: setTimeout(() => undefined, SESSION_IDLE_MS),
          queue: [],
          queuedBytes: 0,
        };
        const client: GatewayWsClient = {
          socket: undefined as never,
          connect: registeredConnect,
          connId,
          isDeviceTokenAuth: true,
          usesSharedGatewayAuth: false,
          clientIp,
        };
        const nodeSession = options.nodeRegistry.registerTransport(
          client,
          { remoteIp: clientIp },
          createTransport(session),
        );
        sessionsByToken.set(session.token, session);
        sessionsByNodeId.set(session.nodeId, session);
        armExpiry(session);
        if (previous) {
          // The new registry entry is current, so unregistering the superseded
          // transport rejects its work without emitting a false offline lifecycle.
          closeSession(previous, "replaced by a newer watch session");
        }
        options.onNodeConnected?.(nodeSession);
        sendJson(res, 200, {
          ok: true,
          sessionToken: session.token,
          deviceToken: issuedDeviceToken,
          nodeId: session.nodeId,
          protocol: PROTOCOL_VERSION,
          pollTimeoutMs: POLL_TIMEOUT_MS,
        });
        const responseCompleted = await responseLifecycle.completed;
        if (!responseCompleted) {
          closeSession(session, "connect response aborted");
          if (revokedBootstrapTokenRecord) {
            await restoreDeviceBootstrapToken({
              record: revokedBootstrapTokenRecord,
              baseDir: options.pairingBaseDir,
            });
          }
          return;
        }
        options.rateLimiter?.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_WATCH_CHALLENGE);
        if (reconciliation.shouldClearPendingPairings && cleanupClaim) {
          const claim = cleanupClaim;
          cleanupClaim = undefined;
          try {
            const resolvedPairings = options.nodeReapprovalCoordinator
              ? await options.nodeReapprovalCoordinator.finalizeCleanup(claim)
              : await finalizeNodePairingCleanupClaim(claim);
            const resolvedAt = now();
            for (const resolved of resolvedPairings) {
              options.broadcast(
                "node.pair.resolved",
                {
                  requestId: resolved.requestId,
                  nodeId: resolved.nodeId,
                  decision: "rejected",
                  ts: resolvedAt,
                },
                { dropIfSlow: true },
              );
            }
          } catch (error) {
            options.onError?.("watch node pending-pairing cleanup failed", error);
          }
        }
        void recordPairedNodeConnection(
          session.nodeId,
          nodeSession.connectedAtMs,
          options.pairingBaseDir,
        ).catch((error: unknown) =>
          options.onError?.("watch node last-connect metadata update failed", error),
        );
      } catch (error) {
        if (session) {
          closeSession(session, "connect failed");
        }
        if (revokedBootstrapTokenRecord) {
          await restoreDeviceBootstrapToken({
            record: revokedBootstrapTokenRecord,
            baseDir: options.pairingBaseDir,
          });
        }
        throw error;
      }
    } finally {
      if (cleanupClaim) {
        await releaseNodePairingCleanupClaim(cleanupClaim);
      }
    }
  };

  const handlePoll = async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }
    const session = getSession(req, res);
    if (!session) {
      return;
    }
    const queued = session.queue.shift();
    if (queued) {
      session.queuedBytes -= queued.byteLength;
      if (!sendQueuedEvent(res, queued)) {
        closeSession(session, "event delivery failed");
      }
      return;
    }
    if (session.waiter) {
      clearTimeout(session.waiter.timer);
      sendJson(session.waiter.res, 409, { ok: false, reason: "superseded poll" });
    }
    const timer = setTimeout(() => {
      if (session.waiter?.res !== res) {
        return;
      }
      session.waiter = undefined;
      if (!res.writableEnded) {
        sendJson(res, 200, { ok: true, event: null });
      }
    }, POLL_TIMEOUT_MS);
    timer.unref?.();
    session.waiter = { res, timer };
    res.once("close", () => {
      if (!res.writableEnded && session.waiter?.res === res) {
        clearTimeout(session.waiter.timer);
        session.waiter = undefined;
        closeSession(session, "poll connection closed");
      }
    });
  };

  const handleDisconnect = (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }
    const session = getSession(req, res);
    if (!session) {
      return;
    }
    closeSession(session, "watch disconnected");
    sendJson(res, 200, { ok: true });
  };

  const handleResult = async (req: IncomingMessage, res: ServerResponse) => {
    if ((req.method ?? "").toUpperCase() !== "POST") {
      sendMethodNotAllowed(res);
      return;
    }
    const session = getSession(req, res);
    if (!session) {
      return;
    }
    const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return;
    }
    if (!isStringRecord(body) || typeof body.id !== "string" || typeof body.ok !== "boolean") {
      sendInvalidRequest(res, "invalid node invoke result");
      return;
    }
    const error = isStringRecord(body.error)
      ? {
          ...(typeof body.error.code === "string" ? { code: body.error.code } : {}),
          ...(typeof body.error.message === "string" ? { message: body.error.message } : {}),
        }
      : null;
    const accepted = options.nodeRegistry.handleInvokeResult({
      id: body.id,
      nodeId: session.nodeId,
      connId: session.connId,
      ok: body.ok,
      payload: body.payload,
      payloadJSON: typeof body.payloadJSON === "string" ? body.payloadJSON : null,
      error,
    });
    sendJson(res, 200, accepted ? { ok: true } : { ok: true, ignored: true });
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = normalizePath(req);
    if (!path?.startsWith(`${BASE_PATH}/`)) {
      return false;
    }
    if (closed) {
      sendJson(res, 503, { ok: false, error: "gateway shutting down" });
      return true;
    }
    res.setHeader("Cache-Control", "no-store");
    switch (path) {
      case CHALLENGE_PATH:
        handleChallenge(req, res);
        return true;
      case CONNECT_PATH:
        await handleConnect(req, res);
        return true;
      case DISCONNECT_PATH:
        handleDisconnect(req, res);
        return true;
      case POLL_PATH:
        await handlePoll(req, res);
        return true;
      case RESULT_PATH:
        await handleResult(req, res);
        return true;
      default:
        sendJson(res, 404, { ok: false, error: "not found" });
        return true;
    }
  };

  return {
    handleRequest,
    invalidateSessionsForDevice: (deviceId, opts) => {
      if (opts?.role && opts.role !== "node") {
        return;
      }
      const session = sessionsByNodeId.get(deviceId);
      if (session) {
        // Match WebSocket invalidation: reject buffered work before the
        // asynchronous transport teardown closes an outstanding long poll.
        session.invalidatedReason = opts?.reason ?? "device-invalidated";
      }
    },
    disconnectSessionsForDevice: (deviceId, opts) => {
      if (opts?.role && opts.role !== "node") {
        return;
      }
      const session = sessionsByNodeId.get(deviceId);
      if (session) {
        closeSession(session, session.invalidatedReason ?? "device removed");
      }
    },
    close: () => {
      closed = true;
      for (const session of sessionsByToken.values()) {
        closeSession(session, "gateway shutting down");
      }
      challenges.clear();
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
