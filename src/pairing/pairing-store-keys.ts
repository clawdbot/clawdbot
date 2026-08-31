import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { PairingChannel } from "./pairing-store.types.js";

type PairingKeyKind = "channel" | "account id";

function describePairingKeyInput(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? `string length ${trimmed.length}` : "empty string";
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return "non-finite number";
  }
  return typeof value;
}

function invalidPairingKeyError(kind: PairingKeyKind, reason: string, value: unknown): Error {
  return new Error(`invalid pairing ${kind}: ${reason}; got ${describePairingKeyInput(value)}`);
}

function normalizePairingKey(value: unknown, kind: PairingKeyKind): string {
  if (typeof value !== "string") {
    throw invalidPairingKeyError(kind, "expected non-empty string", value);
  }
  const raw = normalizeLowercaseStringOrEmpty(value);
  if (!raw) {
    throw invalidPairingKeyError(kind, "expected non-empty string", value);
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw invalidPairingKeyError(kind, "sanitized key is empty", value);
  }
  return safe;
}

export function safeChannelKey(channel: PairingChannel): string {
  return normalizePairingKey(channel, "channel");
}

export function safeAccountKey(accountId: string): string {
  return normalizePairingKey(accountId, "account id");
}

export function dedupePreserveOrder(entries: string[]): string[] {
  return normalizeUniqueStringEntries(entries);
}

export function resolveAllowFromAccountId(accountId?: string): string {
  if (accountId != null && typeof accountId !== "string") {
    throw invalidPairingKeyError("account id", "expected non-empty string", accountId);
  }
  return normalizeLowercaseStringOrEmpty(accountId) || DEFAULT_ACCOUNT_ID;
}
