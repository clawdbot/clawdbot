// Whatsapp plugin module implements status issues behavior.
import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import {
  asString,
  collectIssuesForEnabledAccounts,
  isRecord,
  readAccountStatusSnapshot,
} from "openclaw/plugin-sdk/status-helpers";

const WHATSAPP_ACCOUNT_STATUS_FIELDS = [
  "statusState",
  "linked",
  "reconnectAttempts",
  "lastDisconnect",
  "lastInboundAt",
  "lastError",
  "healthState",
] as const;

const RECENT_DISCONNECT_WARNING_WINDOW_MS = 15 * 60 * 1000;

function readLastDisconnect(value: unknown): { at: number | null; error?: string } | null {
  if (typeof value === "string") {
    const error = asString(value);
    return error ? { at: null, error } : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  return {
    at: typeof value.at === "number" ? value.at : null,
    error: asString(value.error),
  };
}

function isRecentDisconnect(disconnect: { at: number | null } | null, now = Date.now()): boolean {
  if (disconnect?.at == null) {
    return false;
  }
  return now - disconnect.at <= RECENT_DISCONNECT_WARNING_WINDOW_MS;
}

export function collectWhatsAppStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  return collectIssuesForEnabledAccounts({
    accounts,
    readAccount: (value) => readAccountStatusSnapshot(value, WHATSAPP_ACCOUNT_STATUS_FIELDS),
    collectIssues: ({ account, accountId, issues }) => {
      const linked = account.linked === true;
      const statusState = asString(account.statusState);
      const running = account.running === true;
      const connected = account.connected === true;
      const reconnectAttempts =
        typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
      const lastInboundAt =
        typeof account.lastInboundAt === "number" ? account.lastInboundAt : null;
      const lastDisconnect = readLastDisconnect(account.lastDisconnect);
      const lastError = asString(account.lastError) ?? lastDisconnect?.error;
      const healthState = asString(account.healthState);

      if (statusState === "unstable") {
        issues.push({
          channel: "whatsapp",
          accountId,
          kind: "auth",
          message: "Auth state is still stabilizing.",
          fix: "Wait a moment for queued credential writes to finish, then retry the command or rerun health.",
        });
        return;
      }

      if (!linked) {
        issues.push({
          channel: "whatsapp",
          accountId,
          kind: "auth",
          message: "Not linked (no WhatsApp Web session).",
          fix: `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`,
        });
        return;
      }

      if (healthState === "stale") {
        const staleSuffix =
          lastInboundAt != null
            ? ` (last inbound ${Math.max(0, Math.floor((Date.now() - lastInboundAt) / 60000))}m ago)`
            : "";
        issues.push({
          channel: "whatsapp",
          accountId,
          kind: "runtime",
          message: `Linked but stale${staleSuffix}${lastError ? `: ${lastError}` : "."}`,
          fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`,
        });
        return;
      }

      if (
        healthState === "reconnecting" ||
        healthState === "conflict" ||
        healthState === "stopped"
      ) {
        const stateLabel =
          healthState === "conflict"
            ? "session conflict"
            : healthState === "reconnecting"
              ? "reconnecting"
              : "stopped";
        issues.push({
          channel: "whatsapp",
          accountId,
          kind: "runtime",
          message: `Linked but ${stateLabel}${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
          fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`,
        });
        return;
      }

      if (healthState === "logged-out") {
        issues.push({
          channel: "whatsapp",
          accountId,
          kind: "auth",
          message: `Linked session logged out${lastError ? `: ${lastError}` : "."}`,
          fix: `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`,
        });
        return;
      }

      if (
        linked &&
        running &&
        connected &&
        reconnectAttempts != null &&
        reconnectAttempts > 0 &&
        isRecentDisconnect(lastDisconnect)
      ) {
        issues.push({
          channel: "whatsapp",
          accountId,
          kind: "runtime",
          message: `Linked but recently reconnected (reconnectAttempts=${reconnectAttempts})${lastError ? `: ${lastError}` : "."}`,
          fix: `Watch: ${formatCliCommand("openclaw logs --follow")} and run ${formatCliCommand("openclaw channels status --probe")} if disconnects continue. If it keeps flapping, restart the gateway or relink via channels login.`,
        });
        return;
      }

      if (running && !connected) {
        issues.push({
          channel: "whatsapp",
          accountId,
          kind: "runtime",
          message: `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
          fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`,
        });
      }
    },
  });
}
