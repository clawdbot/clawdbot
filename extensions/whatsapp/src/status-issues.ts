import type {
  ChannelAccountSnapshot,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import {
  asString,
  collectIssuesForEnabledAccounts,
  isRecord,
} from "openclaw/plugin-sdk/status-helpers";

type WhatsAppAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  linked?: unknown;
  connected?: unknown;
  running?: unknown;
  reconnectAttempts?: unknown;
  lastInboundAt?: unknown;
  lastError?: unknown;
  healthState?: unknown;
};

function readWhatsAppAccountStatus(value: ChannelAccountSnapshot): WhatsAppAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    linked: value.linked,
    connected: value.connected,
    running: value.running,
    reconnectAttempts: value.reconnectAttempts,
    lastInboundAt: value.lastInboundAt,
    lastError: value.lastError,
    healthState: value.healthState,
  };
}

export function collectWhatsAppStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  return collectIssuesForEnabledAccounts({
    accounts,
    readAccount: readWhatsAppAccountStatus,
    collectIssues: ({ account, accountId, issues }) => {
      const linked = account.linked === true;
      const running = account.running === true;
      const connected = account.connected === true;
      const reconnectAttempts =
        typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
      const lastInboundAt =
        typeof account.lastInboundAt === "number" ? account.lastInboundAt : null;
      const lastError = asString(account.lastError);
      const healthState = asString(account.healthState);

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
