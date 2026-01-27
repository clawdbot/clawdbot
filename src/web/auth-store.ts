import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveOAuthDir } from "../config/paths.js";
import { info, success } from "../globals.js";
import { getChildLogger } from "../logging.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { WebChannel } from "../utils.js";
import { jidToE164, resolveUserPath } from "../utils.js";

export function resolveDefaultWebAuthDir(): string {
  return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}

export const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();

export function resolveWebCredsPath(authDir: string): string {
  return path.join(authDir, "creds.json");
}

export function resolveWebCredsBackupPath(authDir: string): string {
  return path.join(authDir, "creds.json.bak");
}

export function hasWebCredsSync(authDir: string): boolean {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(authDir));
    return stats.isFile() && stats.size > 1;
  } catch {
    return false;
  }
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

export function maybeRestoreCredsFromBackup(authDir: string): void {
  const logger = getChildLogger({ module: "web-session" });
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
    logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
  } catch {
    // ignore
  }
}

export async function webAuthExists(authDir: string = resolveDefaultWebAuthDir()) {
  const resolvedAuthDir = resolveUserPath(authDir);
  maybeRestoreCredsFromBackup(resolvedAuthDir);
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
  const resolvedAuthDir = resolveUserPath(params.authDir ?? resolveDefaultWebAuthDir());
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
    const e164 = jid ? jidToE164(jid, { authDir }) : null;
    return { e164, jid } as const;
  } catch {
    return { e164: null, jid: null } as const;
  }
}

/**
 * Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
 * Helpful for heartbeats/observability to spot stale credentials.
 */
export function getWebAuthAgeMs(authDir: string = resolveDefaultWebAuthDir()): number | null {
  try {
    const stats = fsSync.statSync(resolveWebCredsPath(resolveUserPath(authDir)));
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

export function logWebSelfId(
  authDir: string = resolveDefaultWebAuthDir(),
  runtime: RuntimeEnv = defaultRuntime,
  includeChannelPrefix = false,
) {
  // Human-friendly log of the currently linked personal web session.
  const { e164, jid } = readWebSelfId(authDir);
  const details = e164 || jid ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}` : "unknown";
  const prefix = includeChannelPrefix ? "Web Channel: " : "";
  runtime.log(info(`${prefix}${details}`));
}

export async function pickWebChannel(
  pref: WebChannel | "auto",
  authDir: string = resolveDefaultWebAuthDir(),
): Promise<WebChannel> {
  const choice: WebChannel = pref === "auto" ? "web" : pref;
  const hasWeb = await webAuthExists(authDir);
  if (!hasWeb) {
    throw new Error(
      `No WhatsApp Web session found. Run \`${formatCliCommand("moltbot channels login --channel whatsapp --verbose")}\` to link.`,
    );
  }
  return choice;
}
