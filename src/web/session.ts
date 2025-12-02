import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

import { SESSION_STORE_DEFAULT } from "../config/sessions.js";
import { danger, info, success } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { Provider } from "../utils.js";
import { ensureDir, jidToE164 } from "../utils.js";
import { VERSION } from "../version.js";

export const WA_WEB_AUTH_DIR = path.join(
  os.homedir(),
  ".warelay",
  "credentials",
);

/**
 * Create a Baileys socket backed by the multi-file auth store we keep on disk.
 * Consumers can opt into QR printing for interactive login flows.
 */
export async function createWaSocket(printQr: boolean, verbose: boolean) {
  const logger = getChildLogger(
    { module: "baileys" },
    {
      level: verbose ? "info" : "silent",
    },
  );
  // Some Baileys internals call logger.trace even when silent; ensure it's present.
  const loggerAny = logger as unknown as Record<string, unknown>;
  if (typeof loggerAny.trace !== "function") {
    loggerAny.trace = () => {};
  }
  await ensureDir(WA_WEB_AUTH_DIR);
  const { state, saveCreds } = await useMultiFileAuthState(WA_WEB_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["warelay", "cli", VERSION],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const sessionLogger = getChildLogger({ module: "web-session" });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on(
    "connection.update",
    (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        if (qr && printQr) {
          console.log("Scan this QR in WhatsApp (Linked Devices):");
          qrcode.generate(qr, { small: true });
        }
        if (connection === "close") {
          const status = getStatusCode(lastDisconnect?.error);
          if (status === DisconnectReason.loggedOut) {
            console.error(
              danger("WhatsApp session logged out. Run: warelay login"),
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

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const status = getStatusCode(err);
  const code = (err as { code?: unknown })?.code;
  if (status || code)
    return `status=${status ?? "unknown"} code=${code ?? "unknown"}`;
  return String(err);
}

export async function webAuthExists() {
  return fs
    .access(WA_WEB_AUTH_DIR)
    .then(() => true)
    .catch(() => false);
}

export async function logoutWeb(runtime: RuntimeEnv = defaultRuntime) {
  const exists = await webAuthExists();
  if (!exists) {
    runtime.log(info("No WhatsApp Web session found; nothing to delete."));
    return false;
  }
  await fs.rm(WA_WEB_AUTH_DIR, { recursive: true, force: true });
  // Also drop session store to clear lingering per-sender state after logout.
  await fs.rm(SESSION_STORE_DEFAULT, { force: true });
  runtime.log(
    success(
      "Cleared WhatsApp Web credentials. Run `warelay login --provider web` to relink.",
    ),
  );
  return true;
}

function readWebSelfId() {
  // Read the cached WhatsApp Web identity (jid + E.164) from disk if present.
  const credsPath = path.join(WA_WEB_AUTH_DIR, "creds.json");
  try {
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
export function getWebAuthAgeMs(): number | null {
  const credsPath = path.join(WA_WEB_AUTH_DIR, "creds.json");
  try {
    const stats = fsSync.statSync(credsPath);
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function newConnectionId() {
  return randomUUID();
}

export function logWebSelfId(
  runtime: RuntimeEnv = defaultRuntime,
  includeProviderPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid } = readWebSelfId();
  const details =
    e164 || jid
      ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}`
      : "unknown";
  const prefix = includeProviderPrefix ? "Web Provider: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickProvider(pref: Provider | "auto"): Promise<Provider> {
  // Auto-select web when logged in; otherwise fall back to twilio.
  if (pref !== "auto") return pref;
  const hasWeb = await webAuthExists();
  if (hasWeb) return "web";
  return "twilio";
}
