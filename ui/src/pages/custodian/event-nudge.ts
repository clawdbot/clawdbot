import { html } from "lit";
import { GatewayRequestError, type GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";

export type CustodianEventNudge = {
  severity: 1 | 2 | 3;
  kind: "channel-auth" | "channel-degraded" | "channel-disconnected" | "config-reload";
  channelLabel?: string;
  message: string;
};

export type CustodianSendDelivery = "unsent" | "sent" | "received";
export type CustodianSendOutcome = "sent" | "rejected" | "unknown";

export function classifyCustodianSendFailure(
  error: unknown,
  delivery: CustodianSendDelivery,
): CustodianSendOutcome {
  if (delivery === "received") {
    return "sent";
  }
  if (error instanceof GatewayRequestError || delivery === "unsent") {
    return "rejected";
  }
  return "unknown";
}

export function questionUncertainty(previous: boolean, outcome: CustodianSendOutcome): boolean {
  if (outcome === "sent") {
    return false;
  }
  return outcome === "unknown" ? true : previous;
}

export function shouldConsumeNudge(
  current: CustodianEventNudge | null,
  finished: CustodianEventNudge,
  outcome: CustodianSendOutcome,
): boolean {
  return (
    outcome !== "rejected" &&
    current !== null &&
    current.severity === finished.severity &&
    current.message === finished.message
  );
}

export function reconcileCustodianEventNudge(
  current: CustodianEventNudge | null,
  pending: CustodianEventNudge | null,
  event: Pick<GatewayEventFrame, "event" | "payload">,
): [CustodianEventNudge | null, CustodianEventNudge | null] {
  if (event.event !== "health") {
    return [current, pending];
  }
  const next = classifyCustodianEventNudge(event);
  if (!pending) {
    return [next, null];
  }
  return [next, pending];
}

function eventNudgeText(nudge: CustodianEventNudge): string {
  if (nudge.kind === "config-reload") {
    return t("custodian.nudge.configReload");
  }
  const channel = nudge.channelLabel ?? t("custodian.nudge.channelFallback");
  if (nudge.kind === "channel-auth") {
    return t("custodian.nudge.channelAuth", { channel });
  }
  if (nudge.kind === "channel-disconnected") {
    return t("custodian.nudge.channelDisconnected", { channel });
  }
  return t("custodian.nudge.channelDegraded", { channel });
}

export function renderCustodianEventNudge(params: {
  nudge: CustodianEventNudge;
  disabled: boolean;
  onSend: () => void;
  onDismiss: () => void;
}) {
  return html`<div class="custodian__nudge" role="status">
    <button
      class="custodian__nudge-action"
      type="button"
      ?disabled=${params.disabled}
      @click=${params.onSend}
    >
      ${eventNudgeText(params.nudge)}
    </button>
    <button
      class="custodian__nudge-dismiss"
      type="button"
      aria-label=${t("custodian.nudge.dismiss")}
      @click=${params.onDismiss}
    >
      ×
    </button>
  </div>`;
}

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
function classifyCustodianEventNudge(
  event: Pick<GatewayEventFrame, "event" | "payload">,
): CustodianEventNudge | null {
  return event.event === "health" ? classifyHealth(event.payload) : null;
}
