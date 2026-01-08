import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logVerbose, shouldLogVerbose } from "./globals.js";

export async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

export type Provider = "web";

export function assertProvider(input: string): asserts input is Provider {
  if (input !== "web") {
    throw new Error("Provider must be 'web'");
  }
}

export function normalizePath(p: string): string {
  if (!p.startsWith("/")) return `/${p}`;
  return p;
}

export function withWhatsAppPrefix(number: string): string {
  return number.startsWith("whatsapp:") ? number : `whatsapp:${number}`;
}

export function normalizeE164(number: string): string {
  const withoutPrefix = number.replace(/^whatsapp:/, "").trim();
  const digits = withoutPrefix.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return `+${digits.slice(1)}`;
  return `+${digits}`;
}

/**
 * "Self-chat mode" heuristic (single phone): the gateway is logged in as the owner's own WhatsApp account,
 * and `whatsapp.allowFrom` includes that same number. Used to avoid side-effects that make no sense when the
 * "bot" and the human are the same WhatsApp identity (e.g. auto read receipts, @mention JID triggers).
 */
export function isSelfChatMode(
  selfE164: string | null | undefined,
  allowFrom?: Array<string | number> | null,
): boolean {
  if (!selfE164) return false;
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;
  const normalizedSelf = normalizeE164(selfE164);
  return allowFrom.some((n) => {
    if (n === "*") return false;
    try {
      return normalizeE164(String(n)) === normalizedSelf;
    } catch {
      return false;
    }
  });
}

export function toWhatsappJid(number: string): string {
  const withoutPrefix = number.replace(/^whatsapp:/, "").trim();
  if (withoutPrefix.includes("@")) return withoutPrefix;
  const e164 = normalizeE164(withoutPrefix);
  const digits = e164.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

export function jidToE164(jid: string): string | null {
  // Convert a WhatsApp JID (with optional device suffix, e.g. 1234:1@s.whatsapp.net) back to +1234.
  const match = jid.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  if (match) {
    const digits = match[1];
    return `+${digits}`;
  }

  // Support @lid format (WhatsApp Linked ID) - look up reverse mapping
  const lidMatch = jid.match(/^(\d+)(?::\d+)?@lid$/);
  if (lidMatch) {
    const lid = lidMatch[1];
    try {
      const mappingPath = `${CONFIG_DIR}/credentials/lid-mapping-${lid}_reverse.json`;
      const data = fs.readFileSync(mappingPath, "utf8");
      const phone = JSON.parse(data);
      if (phone) return `+${phone}`;
    } catch {
      if (shouldLogVerbose()) {
        logVerbose(
          `LID mapping not found for ${lid}; skipping inbound message`,
        );
      }
      // Mapping not found, fall through
    }
  }

  return null;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override);
  return path.join(homedir(), ".clawdbot");
}

export function resolveHomeDir(): string | undefined {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;
  const envProfile = process.env.USERPROFILE?.trim();
  if (envProfile) return envProfile;
  try {
    const home = os.homedir();
    return home?.trim() ? home : undefined;
  } catch {
    return undefined;
  }
}

export function shortenHomePath(input: string): string {
  if (!input) return input;
  const home = resolveHomeDir();
  if (!home) return input;
  if (input === home) return "~";
  if (input.startsWith(`${home}/`)) return `~${input.slice(home.length)}`;
  return input;
}

export function shortenHomeInString(input: string): string {
  if (!input) return input;
  const home = resolveHomeDir();
  if (!home) return input;
  return input.split(home).join("~");
}

export function formatTerminalLink(
  label: string,
  url: string,
  opts?: { fallback?: string; force?: boolean },
): string {
  const esc = "\u001b";
  const safeLabel = label.replaceAll(esc, "");
  const safeUrl = url.replaceAll(esc, "");
  const allow =
    opts?.force === true
      ? true
      : opts?.force === false
        ? false
        : Boolean(process.stdout.isTTY);
  if (!allow) {
    return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
  }
  return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}

// Configuration root; can be overridden via CLAWDBOT_STATE_DIR.
export const CONFIG_DIR = resolveConfigDir();
