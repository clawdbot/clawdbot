// Whatsapp plugin module implements session behavior.
import { randomUUID } from "node:crypto";
import type { Agent } from "node:https";
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

async function rejectUnsafeWebCredsPath(authDir: string): Promise<void> {
  await assertWebCredsPathRegularFileOrMissing(resolveWebCredsPath(authDir));
}

function enqueueSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): void {
  enqueueCredsSave(
    authDir,
    () => safeSaveCreds(authDir, saveCreds, logger),
    (err) => {
      logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
    },
  );
}

async function safeSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): Promise<void> {
  try {
    // Best-effort backup so we can recover after abrupt restarts.
    // Important: don't clobber a good backup with a corrupted/truncated creds.json.
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      try {
        JSON.parse(raw);
        await writeWebCredsRawAtomically({
          filePath: backupPath,
          content: raw,
          tempPrefix: ".creds.backup",
        });
      } catch {
        // keep existing backup
      }
    }
  } catch {
    // ignore backup failures
  }
  try {
    await Promise.resolve(saveCreds());
  } catch (err) {
    logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
  }
}

async function printTerminalQr(qr: string): Promise<void> {
  const output = await renderQrTerminal(qr, { small: true });
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
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
  await ensureDir(authDir);
  const sessionLogger = getChildLogger({ module: "web-session" });
  const queueResult = await waitForCredsSaveQueueWithTimeout(authDir);
  if (queueResult === "timed_out") {
    sessionLogger.warn({ authDir }, CREDS_FLUSH_TIMEOUT_MESSAGE);
  } else {
    await rejectUnsafeWebCredsPath(authDir);
    await restoreCredsFromBackupIfNeeded(authDir);
  }
  await rejectUnsafeWebCredsPath(authDir);
  const { state } = await useMultiFileAuthState(authDir);
  const saveCreds = async () => {
    await writeCredsJsonAtomically(authDir, state.creds);
  };
  const { version } = await fetchLatestBaileysVersion();
  const agent = await resolveEnvProxyAgent(sessionLogger);
  const fetchAgent = await resolveEnvFetchDispatcher(sessionLogger, agent);
  const socketTiming = {
    keepAliveIntervalMs:
      opts.keepAliveIntervalMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs,
    connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    defaultQueryTimeoutMs:
      opts.defaultQueryTimeoutMs ?? DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
  };
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
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
  });

  sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, sessionLogger));
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

export type WhatsAppConnectionWaitOptions =
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
