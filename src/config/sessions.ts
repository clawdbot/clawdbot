import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";
import type { MsgContext } from "../auto-reply/templating.js";
import { CONFIG_DIR, normalizeE164 } from "../utils.js";
import { normalizeSessionId } from "../identity/normalize.js";

export type SessionScope = "per-sender" | "global";

export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
};

export const SESSION_STORE_DEFAULT = path.join(CONFIG_DIR, "sessions.json");
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_IDLE_MINUTES = 60;

export function resolveStorePath(store?: string) {
  if (!store) return SESSION_STORE_DEFAULT;
  if (store.startsWith("~"))
    return path.resolve(store.replace("~", os.homedir()));
  return path.resolve(store);
}

export function loadSessionStore(
  storePath: string,
): Record<string, SessionEntry> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, SessionEntry>;
    }
  } catch {
    // ignore missing/invalid store; we'll recreate it
  }
  return {};
}

export async function saveSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  await fs.promises.writeFile(
    storePath,
    JSON.stringify(store, null, 2),
    "utf-8",
  );
}

/**
 * Detect provider from message context.
 *
 * IMPORTANT: This function is only called when the provider isn't explicitly known.
 * For messages coming through the Provider interface, the provider should already
 * be indicated via the message context (e.g., From field with telegram: prefix).
 *
 * Telegram messages should ALWAYS use "telegram:" prefix in the From field to avoid
 * being misidentified as WhatsApp.
 */
function detectProvider(from: string): "whatsapp" | "telegram" | "twilio" {
  // Telegram format: "telegram:123456789" or "telegram:@username"
  if (from.startsWith("telegram:")) {
    return "telegram";
  }
  // WhatsApp username format: "@username" (but NOT telegram:@username)
  if (from.startsWith("@")) {
    return "whatsapp"; // WhatsApp also supports @username format
  }
  // WhatsApp/Twilio use E.164 phone numbers
  // Default to whatsapp for phone numbers
  return "whatsapp";
}

/**
 * Extract raw ID from message context based on provider.
 */
function extractRawId(from: string, provider: "whatsapp" | "telegram" | "twilio"): string {
  if (provider === "telegram") {
    if (from.startsWith("telegram:")) {
      return from.slice("telegram:".length);
    }
    if (from.startsWith("@")) {
      return from; // Keep @ for usernames
    }
    return from;
  }
  // WhatsApp/Twilio: use normalized E.164
  return normalizeE164(from);
}

// Decide which session bucket to use (per-sender vs global).
// Now supports identity mapping for cross-provider session sharing.
export async function deriveSessionKey(scope: SessionScope, ctx: MsgContext): Promise<string> {
  if (scope === "global") return "global";
  const from = ctx.From ? ctx.From : "";

  // Preserve group conversations as distinct buckets (no identity mapping for groups)
  if (typeof ctx.From === "string" && ctx.From.includes("@g.us")) {
    return `group:${ctx.From}`;
  }
  if (typeof ctx.From === "string" && ctx.From.startsWith("group:")) {
    return ctx.From;
  }

  if (!from) return "unknown";

  // Detect provider and extract raw ID
  const provider = detectProvider(from);
  const rawId = extractRawId(from, provider);

  if (!rawId) return "unknown";

  // Use identity normalization to get shared session ID if mapped
  const normalizedId = await normalizeSessionId(provider, rawId);
  return normalizedId;
}
