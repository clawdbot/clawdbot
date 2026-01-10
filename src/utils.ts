import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir } from "./config/paths.js";
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

function stripWhatsAppTargetPrefixes(value: string): string {
  const trimmed = value.trim();
  return trimmed
    .replace(/^whatsapp:/i, "")
    .replace(/^group:/i, "")
    .trim();
}

export function isWhatsAppGroupJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  const lower = candidate.toLowerCase();
  if (!lower.endsWith("@g.us")) return false;
  const localPart = candidate.slice(0, candidate.length - "@g.us".length);
  if (!localPart || localPart.includes("@")) return false;
  return /^[0-9]+(-[0-9]+)*$/.test(localPart);
}

export function normalizeWhatsAppTarget(value: string): string {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) return "";
  if (isWhatsAppGroupJid(candidate)) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return `${localPart}@g.us`;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalized : "";
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

export type JidToE164Options = {
  authDir?: string;
  lidMappingDirs?: string[];
  logMissing?: boolean;
};

type LidLookup = {
  getPNForLID?: (jid: string) => Promise<string | null>;
};

function resolveLidMappingDirs(opts?: JidToE164Options): string[] {
  const dirs = new Set<string>();
  const addDir = (dir?: string | null) => {
    if (!dir) return;
    dirs.add(resolveUserPath(dir));
  };
  addDir(opts?.authDir);
  for (const dir of opts?.lidMappingDirs ?? []) addDir(dir);
  addDir(resolveOAuthDir());
  addDir(path.join(CONFIG_DIR, "credentials"));
  return [...dirs];
}

function readLidReverseMapping(
  lid: string,
  opts?: JidToE164Options,
): string | null {
  const mappingFilename = `lid-mapping-${lid}_reverse.json`;
  const mappingDirs = resolveLidMappingDirs(opts);
  for (const dir of mappingDirs) {
    const mappingPath = path.join(dir, mappingFilename);
    try {
      const data = fs.readFileSync(mappingPath, "utf8");
      const phone = JSON.parse(data) as string | number | null;
      if (phone === null || phone === undefined) continue;
      return normalizeE164(String(phone));
    } catch {
      // Try the next location.
    }
  }
  return null;
}

export function jidToE164(jid: string, opts?: JidToE164Options): string | null {
  // Convert a WhatsApp JID (with optional device suffix, e.g. 1234:1@s.whatsapp.net) back to +1234.
  const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
  if (match) {
    const digits = match[1];
    return `+${digits}`;
  }

  // Support @lid format (WhatsApp Linked ID) - look up reverse mapping
  const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/);
  if (lidMatch) {
    const lid = lidMatch[1];
    const phone = readLidReverseMapping(lid, opts);
    if (phone) return phone;
    const shouldLog = opts?.logMissing ?? shouldLogVerbose();
    if (shouldLog) {
      logVerbose(`LID mapping not found for ${lid}; skipping inbound message`);
    }
  }

  return null;
}

export async function resolveJidToE164(
  jid: string | null | undefined,
  opts?: JidToE164Options & { lidLookup?: LidLookup },
): Promise<string | null> {
  if (!jid) return null;
  const direct = jidToE164(jid, opts);
  if (direct) return direct;
  if (!/(@lid|@hosted\.lid)$/.test(jid)) return null;
  if (!opts?.lidLookup?.getPNForLID) return null;
  try {
    const pnJid = await opts.lidLookup.getPNForLID(jid);
    if (!pnJid) return null;
    return jidToE164(pnJid, opts);
  } catch (err) {
    if (shouldLogVerbose()) {
      logVerbose(`LID mapping lookup failed for ${jid}: ${String(err)}`);
    }
    return null;
  }
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

export function sliceUtf16Safe(
  input: string,
  start: number,
  end?: number,
): string {
  const len = input.length;

  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to =
    end === undefined
      ? len
      : end < 0
        ? Math.max(len + end, 0)
        : Math.min(end, len);

  if (to < from) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  if (from > 0 && from < len) {
    const codeUnit = input.charCodeAt(from);
    if (
      isLowSurrogate(codeUnit) &&
      isHighSurrogate(input.charCodeAt(from - 1))
    ) {
      from += 1;
    }
  }

  if (to > 0 && to < len) {
    const codeUnit = input.charCodeAt(to - 1);
    if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))) {
      to -= 1;
    }
  }

  return input.slice(from, to);
}

export function truncateUtf16Safe(input: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) return input;
  return sliceUtf16Safe(input, 0, limit);
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
