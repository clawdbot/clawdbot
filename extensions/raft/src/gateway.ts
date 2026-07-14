// Raft gateway lifecycle owns the loopback-only wake endpoint and bridge child process.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { keepHttpServerTaskAlive, waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { RAFT_CHANNEL_ID, type ResolvedRaftAccount } from "./accounts.js";
import { dispatchRaftWake } from "./inbound.js";

const BRIDGE_HOST = "127.0.0.1";
const ACTIVITY_DRAIN_PATH = "/activity/drain";
const HEALTH_PATH = "/health";
const WAKE_PATH = "/wake";
const WAKE_TOKEN_HEADER = "x-raft-bridge-token";
const RAFT_ACTIVITY_DRAIN_SCHEMA = "raft-activity-drain.v1";
const MAX_WAKE_BODY_BYTES = 16 * 1024;
const WAKE_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const WAKE_DEDUPE_MEMORY_MAX_SIZE = 1_000;
const WAKE_DEDUPE_STATE_MAX_ENTRIES = 10_000;
const FORBIDDEN_WAKE_CONTENT_KEYS = new Set([
  "body",
  "content",
  "message",
  "messages",
  "preview",
  "snippet",
  "text",
]);
const WAKE_EVENT_ID_FIELDS = [
  "eventId",
  "attemptId",
  "messageId",
  "delivery_id",
  "wake_id",
  "id",
] as const;

type RaftBridgeProcess = Pick<ChildProcess, "kill"> & Pick<EventEmitter, "once">;

type RaftGatewayDeps = {
  createToken?: () => string;
  spawnBridge?: (params: { profile: string; endpoint: string; token: string }) => RaftBridgeProcess;
  wakeDedupe?: ClaimableDedupe;
};

class WakeRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function createToken(): string {
  return randomBytes(32).toString("hex");
}

function spawnRaftBridge(params: {
  profile: string;
  endpoint: string;
  token: string;
}): RaftBridgeProcess {
  // Raft owns the fixed bridge command. OpenClaw passes profile/loopback
  // endpoint/token as separate argv/env fields; wake payloads never reach argv.
  return spawn(
    "raft",
    [
      "--profile",
      params.profile,
      "agent",
      "bridge",
      "--wake-adapter",
      "wake-channel",
      "--wake-channel-endpoint",
      params.endpoint,
    ],
    {
      env: {
        ...process.env,
        RAFT_CHANNEL_TOKEN: params.token,
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
}

function hasMatchingToken(request: IncomingMessage, expected: string): boolean {
  const value = request.headers[WAKE_TOKEN_HEADER];
  if (typeof value !== "string") {
    return false;
  }
  return safeEqualSecret(value, expected);
}

async function readWakePayload(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_WAKE_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) {
    throw new WakeRequestError(413, "Wake payload exceeds the 16 KiB limit.");
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new WakeRequestError(400, "Wake payload must be valid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new WakeRequestError(400, "Wake payload must be an object.");
  }
  return payload as Record<string, unknown>;
}

function containsMessageContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsMessageContent);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) =>
      FORBIDDEN_WAKE_CONTENT_KEYS.has(key.toLowerCase()) || containsMessageContent(child),
  );
}

function resolveWakeEventId(payload: Record<string, unknown>): string | undefined {
  for (const field of WAKE_EVENT_ID_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && value) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function hashWakeEventId(eventId: string): string {
  return createHash("sha256").update(eventId).digest("hex");
}

function resolveWakeDedupeKey(payload: Record<string, unknown>): string | undefined {
  const eventId = resolveWakeEventId(payload);
  return eventId ? hashWakeEventId(`id:${eventId}`) : undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server, sockets: Set<Socket>) {
  for (const socket of sockets) {
    socket.destroy();
  }
  if (server.listening) {
    server.close();
  }
}

function stopBridge(child: RaftBridgeProcess) {
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  forceKill.unref();
  child.once("exit", () => clearTimeout(forceKill));
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, BRIDGE_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Raft wake server did not bind a TCP port.");
  }
  return address.port;
}

export async function startRaftGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedRaftAccount>,
  deps: RaftGatewayDeps = {},
): Promise<void> {
  const profile = ctx.account.profile;
  if (!ctx.account.enabled) {
    await waitUntilAbort(ctx.abortSignal);
    return;
  }
  if (!profile) {
    throw new Error(`Raft account "${ctx.accountId}" is missing a CLI profile.`);
  }
  if (!ctx.channelRuntime) {
    throw new Error("Raft requires OpenClaw channel runtime support. Update OpenClaw and retry.");
  }

  const wakeQueue = new KeyedAsyncQueue();
  const wakeDedupe =
    deps.wakeDedupe ??
    createClaimableDedupe({
      ttlMs: WAKE_DEDUPE_TTL_MS,
      memoryMaxSize: WAKE_DEDUPE_MEMORY_MAX_SIZE,
      pluginId: RAFT_CHANNEL_ID,
      namespacePrefix: "raft-wake-dedupe",
      stateMaxEntries: WAKE_DEDUPE_STATE_MAX_ENTRIES,
      onDiskError: (error) => {
        ctx.log?.warn?.(`Raft wake dedupe storage failed: ${String(error)}`);
      },
    });
  const token = (deps.createToken ?? createToken)();
  const runtimeSession = randomUUID();
  const sockets = new Set<Socket>();
  let stopped = false;
  let bridgeExited: Error | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === HEALTH_PATH) {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (
        request.method === "GET" &&
        new URL(request.url ?? "/", `http://${BRIDGE_HOST}`).pathname === ACTIVITY_DRAIN_PATH
      ) {
        if (!hasMatchingToken(request, token)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        // Raft drains runtime activity after each wake pass. OpenClaw has no
        // portable Raft activity events to export, but must acknowledge an
        // empty batch so the bridge's current protocol remains healthy.
        sendJson(response, 200, {
          schema: RAFT_ACTIVITY_DRAIN_SCHEMA,
          events: [],
          dropped: 0,
        });
        return;
      }
      if (request.method !== "POST" || request.url !== WAKE_PATH) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      if (!hasMatchingToken(request, token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }

      const payload = await readWakePayload(request);
      if (containsMessageContent(payload)) {
        throw new WakeRequestError(400, "Wake payload must not include message content.");
      }
      // Raft owns wake metadata and its schema evolution. OpenClaw accepts only
      // content-free hints, then discards the payload so it cannot reach agent state.
      // Hash delivery identities before durable retention because Raft can retry accepted wakes.
      ctx.setStatus({
        ...ctx.getStatus(),
        accountId: ctx.accountId,
        lastInboundAt: Date.now(),
      });
      const dedupeKey = resolveWakeDedupeKey(payload);
      if (!dedupeKey) {
        throw new WakeRequestError(400, "Wake payload must include a stable event identity.");
      }
      const dispatched = await wakeQueue.enqueue(ctx.accountId, async () => {
        if (ctx.abortSignal?.aborted) {
          throw new WakeRequestError(503, "Raft Gateway is stopping.");
        }
        const claim = await wakeDedupe.claim(dedupeKey, { namespace: ctx.accountId });
        if (claim.kind === "duplicate") {
          return false;
        }
        if (claim.kind === "inflight") {
          if (await claim.pending) {
            return false;
          }
          throw new WakeRequestError(503, "Raft wake delivery is retrying.");
        }
        try {
          await dispatchRaftWake({ ctx });
        } catch (error) {
          wakeDedupe.release(dedupeKey, { namespace: ctx.accountId, error });
          throw error;
        }
        await wakeDedupe.commit(dedupeKey, { namespace: ctx.accountId });
        return true;
      });
      sendJson(response, 202, {
        ok: true,
        accepted: true,
        runtimeSession,
        ...(dispatched ? {} : { duplicate: true }),
      });
    })().catch((error: unknown) => {
      const statusCode = error instanceof WakeRequestError ? error.statusCode : 500;
      const message = error instanceof WakeRequestError ? error.message : "Internal server error.";
      ctx.log?.warn?.(`Raft wake request rejected: ${message}`);
      if (!response.headersSent) {
        sendJson(response, statusCode, { error: message });
      } else {
        response.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let bridge: RaftBridgeProcess | undefined;
  let bridgeStopRequested = false;
  const requestBridgeStop = () => {
    if (!bridge || bridgeStopRequested) {
      return;
    }
    bridgeStopRequested = true;
    stopBridge(bridge);
  };
  try {
    const port = await listenLoopback(server);
    const endpoint = `http://${BRIDGE_HOST}:${port}${WAKE_PATH}`;
    bridge = (deps.spawnBridge ?? spawnRaftBridge)({ profile, endpoint, token });
    bridge.once("error", (error) => {
      if (!stopped) {
        bridgeExited = new Error(`Raft bridge failed to start: ${String(error)}`);
        closeServer(server, sockets);
      }
    });
    bridge.once("exit", (code, signal) => {
      if (!stopped) {
        bridgeExited = new Error(
          `Raft bridge exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"}).`,
        );
        closeServer(server, sockets);
      }
    });

    ctx.setStatus({
      accountId: ctx.accountId,
      running: true,
      connected: true,
      lastStartAt: Date.now(),
      lastError: null,
    });
    ctx.log?.info?.(`Raft bridge started for profile "${profile}".`);

    await keepHttpServerTaskAlive({
      server,
      abortSignal: ctx.abortSignal,
      onAbort: () => {
        stopped = true;
        requestBridgeStop();
        closeServer(server, sockets);
      },
    });
    if (bridgeExited) {
      throw bridgeExited;
    }
  } catch (error) {
    ctx.setStatus({
      accountId: ctx.accountId,
      running: false,
      connected: false,
      lastStopAt: Date.now(),
      lastError: String(error),
    });
    throw error;
  } finally {
    stopped = true;
    requestBridgeStop();
    closeServer(server, sockets);
    ctx.setStatus({
      accountId: ctx.accountId,
      running: false,
      connected: false,
      lastStopAt: Date.now(),
      ...(bridgeExited ? { lastError: bridgeExited.message } : {}),
    });
  }
}
