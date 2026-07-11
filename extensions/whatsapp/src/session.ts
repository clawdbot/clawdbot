// Whatsapp plugin module implements session behavior.
import { randomUUID } from "node:crypto";
import type { Agent } from "node:https";
import type {
  GroupMetadata,
  SignalDataTypeMap,
  SignalKeyStore,
  WAMessageKey,
  proto,
} from "baileys";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import {
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  createNodeProxyAgent,
} from "openclaw/plugin-sdk/fetch-runtime";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger, toPinoLikeLogger } from "openclaw/plugin-sdk/runtime-env";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  readCredsJsonRaw,
  restoreCredsFromBackupIfNeeded,
  resolveDefaultWebAuthDir,
  resolveWebCredsBackupPath,
  resolveWebCredsPath,
} from "./auth-store.js";
import { assertWebCredsPathRegularFileOrMissing } from "./creds-files.js";
import {
  enqueueCredsSave,
  waitForCredsSaveQueueWithTimeout,
  writeCredsJsonAtomically,
  writeWebCredsRawAtomically,
} from "./creds-persistence.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { getStatusCode } from "./session-errors.js";
import {
  createBaileysSignalRepository,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "./session.runtime.js";
import {
  DEFAULT_WHATSAPP_SOCKET_TIMING,
  type WhatsAppSocketTimingOptions,
} from "./socket-timing.js";
export { formatError, getStatusCode } from "./session-errors.js";

export {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  readWebAuthSnapshot,
  readWebAuthState,
  readWebAuthExistsBestEffort,
  readWebAuthExistsForDecision,
  readWebAuthSnapshotBestEffort,
  readWebSelfIdentityForDecision,
  readWebSelfId,
  WHATSAPP_AUTH_UNSTABLE_CODE,
  WhatsAppAuthUnstableError,
  type WhatsAppWebAuthState,
  webAuthExists,
} from "./auth-store.js";
export {
  waitForCredsSaveQueue,
  waitForCredsSaveQueueWithTimeout,
  writeCredsJsonAtomically,
} from "./creds-persistence.js";
export type { CredsQueueWaitResult } from "./creds-persistence.js";

const LOGGED_OUT_STATUS = 401;
const WHATSAPP_WEBSOCKET_PROXY_TARGET = "https://mmg.whatsapp.net/";
const CREDS_FLUSH_TIMEOUT_MESSAGE =
  "Queued WhatsApp creds save did not finish before auth bootstrap; skipping repair and continuing with primary creds.";
export const OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV = "OPENCLAW_WHATSAPP_WEB_SOCKET_URL";

async function rejectUnsafeWebCredsPath(authDir: string): Promise<void> {
  await assertWebCredsPathRegularFileOrMissing(resolveWebCredsPath(authDir));
}

function enqueueSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
  options?: {
    beforeCredentialPersistence?: () => Promise<void>;
    onError?: (error: unknown) => void;
  },
): void {
  enqueueCredsSave(
    authDir,
    () =>
      safeSaveCreds({
        authDir,
        saveCreds,
        logger,
        beforeCredentialPersistence: options?.beforeCredentialPersistence,
      }),
    (err) => {
      logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
      options?.onError?.(err);
    },
  );
}

async function safeSaveCreds(params: {
  authDir: string;
  saveCreds: () => Promise<void> | void;
  logger: ReturnType<typeof getChildLogger>;
  beforeCredentialPersistence?: () => Promise<void>;
}): Promise<void> {
  let backup: { content: string; filePath: string } | undefined;
  try {
    // Best-effort backup so we can recover after abrupt restarts.
    // Important: don't clobber a good backup with a corrupted/truncated creds.json.
    const credsPath = resolveWebCredsPath(params.authDir);
    const backupPath = resolveWebCredsBackupPath(params.authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      try {
        JSON.parse(raw);
        backup = { content: raw, filePath: backupPath };
      } catch {
        // keep existing backup
      }
    }
  } catch {
    // ignore backup failures
  }

  if (backup) {
    await params.beforeCredentialPersistence?.();
    try {
      await writeWebCredsRawAtomically({
        filePath: backup.filePath,
        content: backup.content,
        tempPrefix: ".creds.backup",
      });
    } catch {
      // keep existing backup
    }
  }

  await params.beforeCredentialPersistence?.();
  try {
    await Promise.resolve(params.saveCreds());
  } catch (err) {
    params.logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
    if (params.beforeCredentialPersistence) {
      throw err;
    }
  }
}

function abortSocketAfterCredentialPersistenceFailure(
  sock: ReturnType<typeof makeWASocket>,
  error: unknown,
): void {
  const failure =
    error instanceof Error ? error : new Error("WhatsApp credential persistence rejected");
  const closeWebSocket = () => {
    try {
      void sock.ws?.close?.();
    } catch {
      // ignore best-effort shutdown failures
    }
  };
  try {
    void sock.end(failure).catch(closeWebSocket);
  } catch {
    closeWebSocket();
  }
}

async function printTerminalQr(qr: string): Promise<void> {
  const output = await renderQrTerminal(qr, { small: true });
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

function resolveWaWebSocketUrl(value: string | URL | undefined): string | URL | undefined {
  if (typeof value !== "string") {
    return value;
  }
  return value.trim() || undefined;
}

function resolveEnvWaWebSocketUrl(): string | undefined {
  const value = resolveWaWebSocketUrl(process.env[OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV]);
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV} must be a valid URL.`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`${OPENCLAW_WHATSAPP_WEB_SOCKET_URL_ENV} must use ws:// or wss://.`);
  }
  return url.toString();
}

/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export async function createWaSocket(
  printQr: boolean,
  verbose: boolean,
  opts: {
    authDir?: string;
    onQr?: (qr: string) => void;
    beforeCredentialPersistence?: () => Promise<void>;
    onCredentialPersistenceError?: (error: unknown) => void;
    onCredentialPersistenceTask?: (task: Promise<unknown>) => void;
    getMessage?: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
    cachedGroupMetadata?: (jid: string) => Promise<GroupMetadata | undefined>;
    waWebSocketUrl?: string | URL;
  } & WhatsAppSocketTimingOptions = {},
): Promise<ReturnType<typeof makeWASocket>> {
  const baseLogger = getChildLogger(
    { module: "baileys" },
    {
      level: verbose ? "info" : "silent",
    },
  );
  const logger = toPinoLikeLogger(baseLogger, verbose ? "info" : "silent");
  const authDir = resolveUserPath(opts.authDir ?? resolveDefaultWebAuthDir());
  await rejectUnsafeWebCredsPath(authDir);
  await opts.beforeCredentialPersistence?.();
  await ensureDir(authDir);
  const sessionLogger = getChildLogger({ module: "web-session" });
  const queueResult = await waitForCredsSaveQueueWithTimeout(authDir);
  if (queueResult === "timed_out") {
    sessionLogger.warn({ authDir }, CREDS_FLUSH_TIMEOUT_MESSAGE);
  } else {
    await rejectUnsafeWebCredsPath(authDir);
    await restoreCredsFromBackupIfNeeded(authDir, {
      beforeCredentialPersistence: opts.beforeCredentialPersistence,
    });
  }
  await rejectUnsafeWebCredsPath(authDir);
  const { state } = await useMultiFileAuthState(authDir);
  const saveCreds = async () => {
    await writeCredsJsonAtomically(authDir, state.creds);
  };
  const { version } = await fetchLatestBaileysVersion();
  const waWebSocketUrl = resolveWaWebSocketUrl(opts.waWebSocketUrl) ?? resolveEnvWaWebSocketUrl();
  const agent = await resolveEnvProxyAgent(sessionLogger);
  const fetchAgent = await resolveEnvFetchDispatcher(sessionLogger, agent);
  const socketTiming = {
    keepAliveIntervalMs:
      opts.keepAliveIntervalMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs,
    connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    defaultQueryTimeoutMs:
      opts.defaultQueryTimeoutMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
  };
  const socketRef: { current?: ReturnType<typeof makeWASocket> } = {};
  let pendingSocketAbort: { error: unknown } | undefined;
  const reportCredentialPersistenceError = (error: unknown) => {
    if (socketRef.current) {
      abortSocketAfterCredentialPersistenceFailure(socketRef.current, error);
    } else {
      pendingSocketAbort = { error };
    }
    opts.onCredentialPersistenceError?.(error);
  };
  const persistedSignalKeys: SignalKeyStore = opts.beforeCredentialPersistence
    ? {
        ...state.keys,
        async set(data) {
          await opts.beforeCredentialPersistence?.();
          await state.keys.set(data);
        },
      }
    : state.keys;
  const cachedSignalKeys = makeCacheableSignalKeyStore(persistedSignalKeys, logger);
  const signalKeys: SignalKeyStore = opts.beforeCredentialPersistence
    ? {
        ...cachedSignalKeys,
        get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const task = Promise.resolve(cachedSignalKeys.get(type, ids));
          opts.onCredentialPersistenceTask?.(task);
          return task;
        },
        set(data) {
          const task = (async () => {
            try {
              await cachedSignalKeys.set(data);
            } catch (error) {
              reportCredentialPersistenceError(error);
              throw error;
            }
          })();
          opts.onCredentialPersistenceTask?.(task);
          return task;
        },
      }
    : cachedSignalKeys;
  const makeSignalRepository = opts.onCredentialPersistenceTask
    ? (...args: Parameters<typeof createBaileysSignalRepository>) => {
        const repository = createBaileysSignalRepository(...args);
        const storeLidPnMappings = repository.lidMapping.storeLIDPNMappings.bind(
          repository.lidMapping,
        );
        repository.lidMapping.storeLIDPNMappings = (...storeArgs) => {
          const task = storeLidPnMappings(...storeArgs);
          opts.onCredentialPersistenceTask?.(task);
          void task.then(undefined, reportCredentialPersistenceError);
          return task;
        };
        const migrateSession = repository.migrateSession.bind(repository);
        repository.migrateSession = (...migrateArgs) => {
          const task = migrateSession(...migrateArgs);
          opts.onCredentialPersistenceTask?.(task);
          void task.then(undefined, reportCredentialPersistenceError);
          return task;
        };
        return repository;
      }
    : undefined;
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: signalKeys,
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["openclaw", "cli", VERSION],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    ...socketTiming,
    agent,
    // Baileys types still model `fetchAgent` as a Node agent even though the
    // runtime path accepts an undici dispatcher for upload fetches.
    fetchAgent: fetchAgent as Agent | undefined,
    ...(makeSignalRepository ? { makeSignalRepository } : {}),
    ...(waWebSocketUrl ? { waWebSocketUrl } : {}),
    ...(opts.getMessage ? { getMessage: opts.getMessage } : {}),
    ...(opts.cachedGroupMetadata ? { cachedGroupMetadata: opts.cachedGroupMetadata } : {}),
  });
  socketRef.current = sock;
  if (pendingSocketAbort) {
    abortSocketAfterCredentialPersistenceFailure(sock, pendingSocketAbort.error);
  }

  sock.ev.on("creds.update", () =>
    enqueueSaveCreds(authDir, saveCreds, sessionLogger, {
      beforeCredentialPersistence: opts.beforeCredentialPersistence,
      onError: reportCredentialPersistenceError,
    }),
  );
  sock.ev.on("connection.update", (update: Partial<import("baileys").ConnectionState>) => {
    void (async () => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          opts.onQr?.(qr);
          if (printQr) {
            console.log("Open the WhatsApp app, go to Linked Devices, then scan this QR:");
            void printTerminalQr(qr).catch((err: unknown) => {
              sessionLogger.warn({ error: String(err) }, "failed rendering WhatsApp QR");
            });
          }
        }
        if (connection === "close") {
          const status = getStatusCode(lastDisconnect?.error);
          if (status === LOGGED_OUT_STATUS) {
            console.error(
              danger(
                `WhatsApp session logged out. Run: ${formatCliCommand("openclaw channels login")}`,
              ),
            );
          }
        }
        if (connection === "open" && verbose) {
          console.log(success("WhatsApp Web connected."));
        }
      } catch (err) {
        sessionLogger.error({ error: String(err) }, "connection.update handler error");
      }
    })();
  });

  // Handle WebSocket-level errors to prevent unhandled exceptions from crashing the process
  if (sock.ws && typeof (sock.ws as unknown as { on?: unknown }).on === "function") {
    sock.ws.on("error", (err: Error) => {
      sessionLogger.error({ error: String(err) }, "WebSocket error");
    });
  }

  return sock;
}

async function resolveEnvProxyAgent(
  logger: ReturnType<typeof getChildLogger>,
): Promise<Agent | undefined> {
  try {
    const agent = createNodeProxyAgent({
      mode: "env",
      targetUrl: WHATSAPP_WEBSOCKET_PROXY_TARGET,
      protocol: "https",
    }) as Agent | undefined;
    if (!agent) {
      return undefined;
    }
    logger.info("Using ambient env proxy for WhatsApp WebSocket connection");
    return agent;
  } catch (error) {
    logger.warn(
      { error: String(error) },
      "Failed to initialize env proxy agent for WhatsApp WebSocket connection",
    );
    return undefined;
  }
}

async function resolveEnvFetchDispatcher(
  logger: ReturnType<typeof getChildLogger>,
  agent?: unknown,
): Promise<unknown> {
  const proxyUrl = resolveProxyUrlFromAgent(agent);
  const envProxyUrl = resolveEnvHttpsProxyUrl();
  if (!proxyUrl && !envProxyUrl) {
    return undefined;
  }
  try {
    return proxyUrl ? createHttp1ProxyAgent({ uri: proxyUrl }) : createHttp1EnvHttpProxyAgent();
  } catch (error) {
    logger.warn(
      { error: String(error) },
      "Failed to initialize env proxy dispatcher for WhatsApp media uploads",
    );
    return undefined;
  }
}

function resolveProxyUrlFromAgent(agent: unknown): string | undefined {
  if (
    typeof agent === "object" &&
    agent !== null &&
    "getProxyForUrl" in agent &&
    typeof agent.getProxyForUrl === "function"
  ) {
    const proxyUrl = agent.getProxyForUrl(WHATSAPP_WEBSOCKET_PROXY_TARGET);
    return typeof proxyUrl === "string" && proxyUrl.length > 0 ? proxyUrl : undefined;
  }
  if (typeof agent !== "object" || agent === null || !("proxy" in agent)) {
    return undefined;
  }
  const proxy = (agent as { proxy?: unknown }).proxy;
  if (proxy instanceof URL) {
    return proxy.toString();
  }
  return typeof proxy === "string" && proxy.length > 0 ? proxy : undefined;
}

function resolveEnvHttpsProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const lowerHttpsProxy = normalizeEnvProxyValue(env.https_proxy);
  const lowerHttpProxy = normalizeEnvProxyValue(env.http_proxy);
  const httpsProxy =
    lowerHttpsProxy !== undefined ? lowerHttpsProxy : normalizeEnvProxyValue(env.HTTPS_PROXY);
  const httpProxy =
    lowerHttpProxy !== undefined ? lowerHttpProxy : normalizeEnvProxyValue(env.HTTP_PROXY);
  return httpsProxy ?? httpProxy ?? undefined;
}

function normalizeEnvProxyValue(value: string | undefined): string | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type WhatsAppConnectionWaitOptions =
  | {
      timeout: "none";
    }
  | {
      timeoutMs: number;
    };

export async function waitForWaConnection(
  sock: ReturnType<typeof makeWASocket>,
  options: WhatsAppConnectionWaitOptions = { timeout: "none" },
) {
  return new Promise<void>((resolve, reject) => {
    type OffCapable = {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const evWithOff = sock.ev as unknown as OffCapable;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      evWithOff.off?.("connection.update", handler);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const handler = (...args: unknown[]) => {
      const update = (args[0] ?? {}) as Partial<import("baileys").ConnectionState>;
      if (update.connection === "open") {
        cleanup();
        resolve();
      }
      if (update.connection === "close") {
        cleanup();
        reject(
          toLintErrorObject(
            update.lastDisconnect ?? new Error("Connection closed"),
            "Non-Error rejection",
          ),
        );
      }
    };

    sock.ev.on("connection.update", handler);

    if ("timeoutMs" in options) {
      const timeoutMs = options.timeoutMs;
      timer = setTimeout(() => {
        cleanup();
        reject(createConnectionTimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

export function newConnectionId() {
  return randomUUID();
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

function createConnectionTimeoutError(timeoutMs: number): Error {
  const error = new Error(`WhatsApp connection timed out after ${timeoutMs}ms`);
  Object.assign(error, {
    output: {
      statusCode: 408,
    },
  });
  return error;
}
