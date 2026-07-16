// Signal plugin module implements identity behavior.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { looksLikeUuid } from "./uuid.js";

type SignalSenderAliases = {
  e164?: string;
  uuid?: string;
};

export type SignalSender =
  | { kind: "phone"; raw: string; e164: string; aliases?: SignalSenderAliases }
  | { kind: "uuid"; raw: string; aliases?: SignalSenderAliases };

type SignalAllowEntry =
  | { kind: "any" }
  | { kind: "phone"; e164: string }
  | { kind: "uuid"; raw: string };

export { looksLikeUuid } from "./uuid.js";

function stripSignalPrefix(value: string): string {
  return value.replace(/^signal:/i, "").trim();
}

export function resolveSignalSender(params: {
  sourceNumber?: string | null;
  sourceUuid?: string | null;
}): SignalSender | null {
  const sourceNumber = params.sourceNumber?.trim();
  const sourceUuid = params.sourceUuid?.trim();
  if (sourceNumber) {
    const e164 = normalizeE164(sourceNumber);
    if (e164) {
      return {
        kind: "phone",
        raw: sourceNumber,
        e164,
        ...(sourceUuid ? { aliases: { uuid: sourceUuid } } : {}),
      };
    }
  }
  if (sourceUuid) {
    return { kind: "uuid", raw: sourceUuid };
  }
  return null;
}

export function formatSignalSenderId(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}

export function formatSignalSenderDisplay(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}

export function formatSignalPairingIdLine(sender: SignalSender): string {
  if (sender.kind === "phone") {
    return `Your Signal number: ${sender.e164}`;
  }
  return `Your Signal sender id: ${formatSignalSenderId(sender)}`;
}

export function resolveSignalRecipient(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : sender.raw;
}

export function resolveSignalPeerId(sender: SignalSender): string {
  return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}

function parseSignalAllowEntry(entry: string): SignalAllowEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return { kind: "any" };
  }

  const stripped = stripSignalPrefix(trimmed);
  const lower = normalizeLowercaseStringOrEmpty(stripped);
  if (lower.startsWith("uuid:")) {
    const raw = stripped.slice("uuid:".length).trim();
    if (!raw) {
      return null;
    }
    return { kind: "uuid", raw };
  }

  if (looksLikeUuid(stripped)) {
    return { kind: "uuid", raw: stripped };
  }

  const e164 = normalizeE164(stripped);
  return e164 ? { kind: "phone", e164 } : null;
}

export function normalizeSignalAllowRecipient(entry: string): string | undefined {
  const parsed = parseSignalAllowEntry(entry);
  if (!parsed || parsed.kind === "any") {
    return undefined;
  }
  return parsed.kind === "phone" ? parsed.e164 : parsed.raw;
}

export function isSignalSenderAllowed(sender: SignalSender, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) {
    return false;
  }
  const parsed = allowFrom
    .map(parseSignalAllowEntry)
    .filter((entry): entry is SignalAllowEntry => entry !== null);
  if (parsed.some((entry) => entry.kind === "any")) {
    return true;
  }
  // A sender carries an alias when signal-cli has both forms cached locally
  // (e.g. after the daemon resolved a number → uuid for an outbound send).
  // Treat both forms as the same identity so an allowlist entry approved as
  // one form keeps matching after the other becomes available.
  const senderE164 = sender.kind === "phone" ? sender.e164 : sender.aliases?.e164;
  const senderUuid = sender.kind === "uuid" ? sender.raw : sender.aliases?.uuid;
  return parsed.some((entry) => {
    if (entry.kind === "phone") {
      return senderE164 !== undefined && entry.e164 === senderE164;
    }
    if (entry.kind === "uuid") {
      return senderUuid !== undefined && entry.raw === senderUuid;
    }
    return false;
  });
}
