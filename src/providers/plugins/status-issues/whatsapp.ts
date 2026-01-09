import type {
  ProviderAccountSnapshot,
  ProviderStatusIssue,
} from "../types.js";
import { asString, isRecord } from "./shared.js";

type WhatsAppAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  linked?: unknown;
  connected?: unknown;
  running?: unknown;
  reconnectAttempts?: unknown;
  lastError?: unknown;
};

function readWhatsAppAccountStatus(
  value: ProviderAccountSnapshot,
): WhatsAppAccountStatus | null {
  if (!isRecord(value)) return null;
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    linked: value.linked,
    connected: value.connected,
    running: value.running,
    reconnectAttempts: value.reconnectAttempts,
    lastError: value.lastError,
  };
}

export function collectWhatsAppStatusIssues(
  accounts: ProviderAccountSnapshot[],
): ProviderStatusIssue[] {
  const issues: ProviderStatusIssue[] = [];
  for (const entry of accounts) {
    const account = readWhatsAppAccountStatus(entry);
    if (!account) continue;
    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;
    if (!enabled) continue;
    const linked = account.linked === true;
    const running = account.running === true;
    const connected = account.connected === true;
    const reconnectAttempts =
      typeof account.reconnectAttempts === "number"
        ? account.reconnectAttempts
        : null;
    const lastError = asString(account.lastError);

    if (!linked) {
      issues.push({
        provider: "whatsapp",
        accountId,
        kind: "auth",
        message: "Not linked (no WhatsApp Web session).",
        fix: "Run: clawdbot providers login (scan QR on the gateway host).",
      });
      continue;
    }

    if (running && !connected) {
      issues.push({
        provider: "whatsapp",
        accountId,
        kind: "runtime",
        message: `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
        fix: "Run: clawdbot doctor (or restart the gateway). If it persists, relink via providers login and check logs.",
      });
    }
  }
  return issues;
}
