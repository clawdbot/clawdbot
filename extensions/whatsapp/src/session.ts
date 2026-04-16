import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { Agent } from "node:https";
import path from "node:path";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { VERSION } from "openclaw/plugin-sdk/cli-runtime";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger, toPinoLikeLogger } from "openclaw/plugin-sdk/runtime-env";
import { ensureDir, resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import {
  maybeRestoreCredsFromBackup,
  readCredsJsonRaw,
  resolveDefaultWebAuthDir,
  resolveWebCredsBackupPath,
  resolveWebCredsPath,
} from "./auth-store.js";
import { formatError, getStatusCode } from "./session-errors.js";
import {
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "./session.runtime.js";
export { formatError, getStatusCode } from "./session-errors.js";

export {
  getWebAuthAgeMs,
  logoutWeb,
  logWebSelfId,
  pickWebChannel,
  readWebSelfId,
  WA_WEB_AUTH_DIR,
  webAuthExists,
} from "./auth-store.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;

async function loadQrTerminal() {
  const mod = await import("qrcode-terminal");
  return mod.default ?? mod;
}

export async function writeCredsJsonAtomically(
  authDir: string,
  creds: unknown,
): Promise<void> {
  const credsPath = resolveWebCredsPath(authDir);
  const tempPath = path.join(authDir, `.creds.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tempPath, JSON.stringify(creds, BufferJSON.replacer), { mode: 0o600 });
    await fs.rename(tempPath, credsPath);
  } catch (err) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

// Per-authDir queues so multi-account creds saves don't block each other.
const credsSaveQueues = new Map<string, Promise<void>>();
const CREDS_SAVE_FLUSH_TIMEOUT_MS = 15_000;
function enqueueSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): void {
  const prev = credsSaveQueues.get(authDir) ?? Promise.resolve();
  const next = prev
    .then(() => safeSaveCreds(authDir, saveCreds, logger))
    .catch((err) => {
      logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
    })
    .finally(() => {
      if (credsSaveQueues.get(authDir) === next) {
        credsSaveQueues.delete(authDir);
      }
    });
  credsSaveQueues.set(authDir, next);
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
        fsSync.copyFileSync(credsPath, backupPath);
        try {
          fsSync.chmodSync(backupPath, 0o600);
        } catch {
          // best-effort on platforms that support it
        }
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

/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export async function createWaSocket(
  printQr: boolean,
  verbose: boolean,
  opts: { authDir?: string; onQr?: (qr: string) => void } = {},
): Promise<ReturnType<typeof makeWASocket>> {
  const baseLogger = getChildLogger(
    { module: "baileys" },
    {
      level: verbose ? "info" : "silent",
    },
  );
  const logger = toPinoLikeLogger(baseLogger, verbose ? "info" : "silent");
  const authDir = resolveUserPath(opts.authDir ?? resolveDefaultWebAuthDir());
  await ensureDir(authDir);
  const sessionLogger = getChildLogger({ module: "web-session" });
  maybeRestoreCredsFromBackup(authDir);
  const { state } = await useMultiFileAuthState(authDir);
  const saveCreds = async () => {
    await writeCredsJsonAtomically(authDir, state.creds);
  };
  const { version } = await fetchLatestBaileysVersion();
  const agent = await resolveEnvProxyAgent(sessionLogger);
  const fetchAgent = await resolveEnvFetchDispatcher(sessionLogger, agent);
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
    agent,
    // Baileys types still model `fetchAgent` as a Node agent even though the
    // runtime path accepts an undici dispatcher for upload fetches.
    fetchAgent: fetchAgent as Agent | undefined,
  });

  sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, sessionLogger));
  sock.ev.on(
    "connection.update",
    async (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          opts.onQr?.(qr);
          if (printQr) {
            console.log("Scan this QR in WhatsApp (Linked Devices):");
            const qrcode = await loadQrTerminal();
            qrcode.generate(qr, { small: true });
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
    },
  );

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
  return resolveAmbientNodeProxyAgent<Agent>({
    onError: (err) => {
      logger.warn(
        { error: String(err) },
        "Failed to initialize env proxy agent for WhatsApp WebSocket connection",
      );
    },
    onUsingProxy: () => {
      logger.info("Using ambient env proxy for WhatsApp WebSocket connection");
    },
  });
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
    const { EnvHttpProxyAgent, ProxyAgent } = await import("undici");
    return proxyUrl
      ? new ProxyAgent({ allowH2: false, uri: proxyUrl })
      : new EnvHttpProxyAgent({ allowH2: false });
  } catch (error) {
    logger.warn(
      { error: String(error) },
      "Failed to initialize env proxy dispatcher for WhatsApp media uploads",
    );
    return undefined;
  }
}

function resolveProxyUrlFromAgent(agent: unknown): string | undefined {
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

export async function waitForWaConnection(sock: ReturnType<typeof makeWASocket>) {
  return new Promise<void>((resolve, reject) => {
    type OffCapable = {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const evWithOff = sock.ev as unknown as OffCapable;

    const handler = (...args: unknown[]) => {
      const update = (args[0] ?? {}) as Partial<import("@whiskeysockets/baileys").ConnectionState>;
      if (update.connection === "open") {
        evWithOff.off?.("connection.update", handler);
        resolve();
      }
      if (update.connection === "close") {
        evWithOff.off?.("connection.update", handler);
        reject(update.lastDisconnect ?? new Error("Connection closed"));
      }
    };

    sock.ev.on("connection.update", handler);
  });
}

/** Await pending credential saves — scoped to one authDir, or all if omitted. */
export function waitForCredsSaveQueue(authDir?: string): Promise<void> {
  if (authDir) {
    return credsSaveQueues.get(authDir) ?? Promise.resolve();
  }
  return Promise.all(credsSaveQueues.values()).then(() => {});
}

/** Await pending credential saves, but don't hang forever on stalled I/O. */
export async function waitForCredsSaveQueueWithTimeout(
  authDir: string,
  timeoutMs = CREDS_SAVE_FLUSH_TIMEOUT_MS,
): Promise<void> {
  let flushTimeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    waitForCredsSaveQueue(authDir),
    new Promise<void>((resolve) => {
      flushTimeout = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
    }
  });
}

export function newConnectionId() {
  return randomUUID();
}
