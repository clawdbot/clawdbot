import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { resolveOAuthDir } from "../config/paths.js";
import { danger, info, success } from "../globals.js";
import { getChildLogger, toPinoLikeLogger } from "../logging.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { Provider } from "../utils.js";
import { ensureDir, jidToE164, resolveUserPath } from "../utils.js";
import { VERSION } from "../version.js";

function resolveDefaultWebAuthDir(): string {
  return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}

export const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();

function resolveWebCredsPath(authDir: string) {
  return path.join(authDir, "creds.json");
}

function resolveWebCredsBackupPath(authDir: string) {
  return path.join(authDir, "creds.json.bak");
}

let credsSaveQueue: Promise<void> = Promise.resolve();
function enqueueSaveCreds(
  authDir: string,
  saveCreds: () => Promise<void> | void,
  logger: ReturnType<typeof getChildLogger>,
): void {
  credsSaveQueue = credsSaveQueue
    .then(() => safeSaveCreds(authDir, saveCreds, logger))
    .catch((err) => {
      logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
    });
}

function readCredsJsonRaw(filePath: string): string | null {
  try {
    if (!fsSync.existsSync(filePath)) return null;
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) return null;
    return fsSync.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function maybeRestoreCredsFromBackup(
  authDir: string,
  logger: ReturnType<typeof getChildLogger>,
): void {
  try {
    const credsPath = resolveWebCredsPath(authDir);
    const backupPath = resolveWebCredsBackupPath(authDir);
    const raw = readCredsJsonRaw(credsPath);
    if (raw) {
      // Validate that creds.json is parseable.
      JSON.parse(raw);
      return;
    }

    const backupRaw = readCredsJsonRaw(backupPath);
    if (!backupRaw) return;

    // Ensure backup is parseable before restoring.
    JSON.parse(backupRaw);
    fsSync.copyFileSync(backupPath, credsPath);
    logger.warn(
      { credsPath },
      "restored corrupted WhatsApp creds.json from backup",
    );
  } catch {
    // ignore
  }
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
) {
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
  maybeRestoreCredsFromBackup(authDir, sessionLogger);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["clawdbot", "cli", VERSION],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", () =>
    enqueueSaveCreds(authDir, saveCreds, sessionLogger),
  );
  sock.ev.on(
    "connection.update",
    (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          opts.onQr?.(qr);
          if (printQr) {
            console.log("Scan this QR in WhatsApp (Linked Devices):");
            qrcode.generate(qr, { small: true });
          }
        }
        if (connection === "close") {
          const status = getStatusCode(lastDisconnect?.error);
          if (status === DisconnectReason.loggedOut) {
            console.error(
              danger(
                "WhatsApp session logged out. Run: clawdbot providers login",
              ),
            );
          }
        }
        if (connection === "open" && verbose) {
          console.log(success("WhatsApp Web connected."));
        }
      } catch (err) {
        sessionLogger.error(
          { error: String(err) },
          "connection.update handler error",
        );
      }
    },
  );

  // Handle WebSocket-level errors to prevent unhandled exceptions from crashing the process
  if (
    sock.ws &&
    typeof (sock.ws as unknown as { on?: unknown }).on === "function"
  ) {
    sock.ws.on("error", (err: Error) => {
      sessionLogger.error({ error: String(err) }, "WebSocket error");
    });
  }

  return sock;
}

export async function waitForWaConnection(
  sock: ReturnType<typeof makeWASocket>,
) {
  return new Promise<void>((resolve, reject) => {
    type OffCapable = {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    const evWithOff = sock.ev as unknown as OffCapable;

    const handler = (...args: unknown[]) => {
      const update = (args[0] ?? {}) as Partial<
        import("@whiskeysockets/baileys").ConnectionState
      >;
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

export function getStatusCode(err: unknown) {
  return (
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status
  );
}

function safeStringify(value: unknown, limit = 800): string {
  try {
    const seen = new WeakSet<object>();
    const raw = JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "function") {
          const maybeName = (v as { name?: unknown }).name;
          const name =
            typeof maybeName === "string" && maybeName.length > 0
              ? maybeName
              : "anonymous";
          return `[Function ${name}]`;
        }
        if (typeof v === "object" && v) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        return v;
      },
      2,
    );
    if (!raw) return String(value);
    return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
  } catch {
    return String(value);
  }
}

function extractBoomDetails(err: unknown): {
  statusCode?: number;
  error?: string;
  message?: string;
} | null {
  if (!err || typeof err !== "object") return null;
  const output = (err as { output?: unknown })?.output as
    | { statusCode?: unknown; payload?: unknown }
    | undefined;
  if (!output || typeof output !== "object") return null;
  const payload = (output as { payload?: unknown }).payload as
    | { error?: unknown; message?: unknown; statusCode?: unknown }
    | undefined;
  const statusCode =
    typeof (output as { statusCode?: unknown }).statusCode === "number"
      ? ((output as { statusCode?: unknown }).statusCode as number)
      : typeof payload?.statusCode === "number"
        ? (payload.statusCode as number)
        : undefined;
  const error = typeof payload?.error === "string" ? payload.error : undefined;
  const message =
    typeof payload?.message === "string" ? payload.message : undefined;
  if (!statusCode && !error && !message) return null;
  return { statusCode, error, message };
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return String(err);

  // Baileys frequently wraps errors under `error` with a Boom-like shape.
  const boom =
    extractBoomDetails(err) ??
    extractBoomDetails((err as { error?: unknown })?.error) ??
    extractBoomDetails(
      (err as { lastDisconnect?: { error?: unknown } })?.lastDisconnect?.error,
    );

  const status = boom?.statusCode ?? getStatusCode(err);
  const code = (err as { code?: unknown })?.code;
  const codeText =
    typeof code === "string" || typeof code === "number"
      ? String(code)
      : undefined;

  const messageCandidates = [
    boom?.message,
    typeof (err as { message?: unknown })?.message === "string"
      ? ((err as { message?: unknown }).message as string)
      : undefined,
    typeof (err as { error?: { message?: unknown } })?.error?.message ===
    "string"
      ? ((err as { error?: { message?: unknown } }).error?.message as string)
      : undefined,
  ].filter((v): v is string => Boolean(v && v.trim().length > 0));
  const message = messageCandidates[0];

  const pieces: string[] = [];
  if (typeof status === "number") pieces.push(`status=${status}`);
  if (boom?.error) pieces.push(boom.error);
  if (message) pieces.push(message);
  if (codeText) pieces.push(`code=${codeText}`);

  if (pieces.length > 0) return pieces.join(" ");
  return safeStringify(err);
}

export async function webAuthExists(
  authDir: string = resolveDefaultWebAuthDir(),
) {
  const sessionLogger = getChildLogger({ module: "web-session" });
  const resolvedAuthDir = resolveUserPath(authDir);
  maybeRestoreCredsFromBackup(resolvedAuthDir, sessionLogger);
  const credsPath = resolveWebCredsPath(resolvedAuthDir);
  try {
    await fs.access(resolvedAuthDir);
  } catch {
    return false;
  }
  try {
    const stats = await fs.stat(credsPath);
    if (!stats.isFile() || stats.size <= 1) return false;
    const raw = await fs.readFile(credsPath, "utf-8");
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

async function clearLegacyBaileysAuthState(authDir: string) {
  const entries = await fs.readdir(authDir, { withFileTypes: true });
  const shouldDelete = (name: string) => {
    if (name === "oauth.json") return false;
    if (name === "creds.json" || name === "creds.json.bak") return true;
    if (!name.endsWith(".json")) return false;
    return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
  };
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      if (!shouldDelete(entry.name)) return;
      await fs.rm(path.join(authDir, entry.name), { force: true });
    }),
  );
}

export async function logoutWeb(params: {
  authDir?: string;
  isLegacyAuthDir?: boolean;
  runtime?: RuntimeEnv;
}) {
  const runtime = params.runtime ?? defaultRuntime;
  const resolvedAuthDir = resolveUserPath(
    params.authDir ?? resolveDefaultWebAuthDir(),
  );
  const exists = await webAuthExists(resolvedAuthDir);
  if (!exists) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  if (params.isLegacyAuthDir) {
    await clearLegacyBaileysAuthState(resolvedAuthDir);
  } else {
    await fs.rm(resolvedAuthDir, { recursive: true, force: true });
  }
  runtime.log(success("Cleared WhatsApp Web credentials."));
  return true;
}

export function readWebSelfId(authDir: string = resolveDefaultWebAuthDir()) {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  try {
    const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
    if (!fsSync.existsSync(credsPath)) {
      return { e164: null, jid: null } as const;
    }
    const raw = fsSync.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string } } | undefined;
    const jid = parsed?.me?.id ?? null;
    const e164 = jid ? jidToE164(jid) : null;
    return { e164, jid } as const;
  } catch {
    return { e164: null, jid: null } as const;
  }
}

/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export function getWebAuthAgeMs(
  authDir: string = resolveDefaultWebAuthDir(),
): number | null {
  try {
    const stats = fsSync.statSync(
      resolveWebCredsPath(resolveUserPath(authDir)),
    );
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function newConnectionId() {
  return randomUUID();
}

export function logWebSelfId(
  authDir: string = resolveDefaultWebAuthDir(),
  runtime: RuntimeEnv = defaultRuntime,
  includeProviderPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid } = readWebSelfId(authDir);
  const details =
    e164 || jid
      ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}`
      : "unknown";
  const prefix = includeProviderPrefix ? "Web Provider: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickProvider(
  pref: Provider | "auto",
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<Provider> {
  const choice: Provider = pref === "auto" ? "web" : pref;
  const hasWeb = await webAuthExists(authDir);
  if (!hasWeb) {
    throw new Error(
      "No WhatsApp Web session found. Run `clawdbot providers login --verbose` to link.",
    );
  }
  return choice;
}
