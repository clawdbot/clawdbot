import type { GatewayEventFrame } from "../../api/gateway.ts";

export type CustodianEventNudge = {
  severity: 1 | 2 | 3;
  kind: "channel-auth" | "channel-degraded" | "channel-disconnected" | "config-reload";
  channelLabel?: string;
  message: string;
};

type UnknownRecord = Record<string, unknown>;

const CONSEQUENTIAL_CHANNEL_STATES = new Set([
  "disconnected",
  "stale-socket",
  "stuck",
  "terminal-disconnect",
]);
const CHANNEL_AUTH_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasUnavailableAuth(account: UnknownRecord): boolean {
  return CHANNEL_AUTH_STATUS_KEYS.some((key) => account[key] === "configured_unavailable");
}

function hasFailedProbe(account: UnknownRecord): boolean {
  return asRecord(account.probe)?.ok === false;
}

function classifyChannelAccount(
  channelId: string,
  label: string,
  account: UnknownRecord,
): CustodianEventNudge | null {
  if (account.configured === false || account.enabled === false) {
    return null;
  }
  const canonical = channelId.toLowerCase();
  if (hasUnavailableAuth(account)) {
    return {
      severity: 3,
      kind: "channel-auth",
      channelLabel: label,
      message: `what happened with ${canonical} authentication?`,
    };
  }
  const healthState =
    typeof account.healthState === "string" ? account.healthState.trim().toLowerCase() : undefined;
  if (healthState === "terminal-disconnect") {
    return {
      severity: 3,
      kind: "channel-degraded",
      channelLabel: label,
      message: `what happened with ${canonical}?`,
    };
  }
  if (hasFailedProbe(account)) {
    return {
      severity: 3,
      kind: "channel-degraded",
      channelLabel: label,
      message: `what happened with ${canonical}?`,
    };
  }
  if (healthState === "not-running" && account.running === false) {
    const reconnectAttempts =
      typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : 0;
    const lastStartAt = typeof account.lastStartAt === "number" ? account.lastStartAt : undefined;
    const lastStopAt = typeof account.lastStopAt === "number" ? account.lastStopAt : undefined;
    if (
      account.restartPending === false &&
      lastStopAt !== undefined &&
      (lastStartAt === undefined || lastStopAt >= lastStartAt) &&
      reconnectAttempts < 10
    ) {
      // server-channels only leaves this low-count, non-retrying shape after a clean/manual stop.
      // A newer start timestamp means a pre-handoff startup failed after an earlier clean stop.
      return null;
    }
  }
  if (
    account.connected !== true &&
    healthState !== "healthy" &&
    typeof account.lastError === "string" &&
    account.lastError.trim()
  ) {
    return {
      severity: 3,
      kind: "channel-degraded",
      channelLabel: label,
      message: `what happened with ${canonical}?`,
    };
  }
  if (account.connected === false && account.running === true) {
    return {
      severity: 2,
      kind: "channel-disconnected",
      channelLabel: label,
      message: `what happened with ${canonical}?`,
    };
  }
  if (healthState && CONSEQUENTIAL_CHANNEL_STATES.has(healthState)) {
    return {
      severity: 1,
      kind: "channel-degraded",
      channelLabel: label,
      message: `what happened with ${canonical}?`,
    };
  }
  return null;
}

function classifyHealth(payload: unknown): CustodianEventNudge | null {
  const health = asRecord(payload);
  if (!health) {
    return null;
  }
  if (asRecord(health.configReload)?.hotReloadStatus === "disabled") {
    return {
      severity: 3,
      kind: "config-reload",
      message: "what happened with configuration reload?",
    };
  }
  const channels = asRecord(health.channels);
  if (!channels) {
    return null;
  }
  const labels = asRecord(health.channelLabels);
  let best: CustodianEventNudge | null = null;
  for (const [channelId, channelValue] of Object.entries(channels)) {
    const channel = asRecord(channelValue);
    if (!channel) {
      continue;
    }
    const label = typeof labels?.[channelId] === "string" ? labels[channelId] : channelId;
    const accounts = asRecord(channel.accounts);
    const accountCandidates = accounts
      ? Object.values(accounts)
          .map(asRecord)
          .filter((value) => value !== null)
      : [];
    // The channel-level record duplicates the preferred account. Per-account
    // rows are authoritative when present and may have different enabled state.
    const candidates = accountCandidates.length > 0 ? accountCandidates : [channel];
    for (const account of candidates) {
      const nudge = classifyChannelAccount(channelId, label, account);
      if (nudge && (!best || nudge.severity > best.severity)) {
        best = nudge;
      }
    }
  }
  return best;
}

/** Only Gateway health failures produce presence nudges; success/info events stay silent. */
export function classifyCustodianEventNudge(
  event: Pick<GatewayEventFrame, "event" | "payload">,
): CustodianEventNudge | null {
  return event.event === "health" ? classifyHealth(event.payload) : null;
}
