// Channels page shared view helpers.
import { html, nothing } from "lit";
import type { ChannelAccountSnapshot } from "../../api/types.ts";
import { renderSettingsSection, renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { ChannelKey, ChannelsProps } from "./view.types.ts";

type ChannelDisplayState = {
  configured: boolean | null;
  running: boolean | null;
  connected: boolean | null;
  defaultAccount: ChannelAccountSnapshot | null;
  hasAnyActiveAccount: boolean;
  status: Record<string, unknown> | undefined;
};

type ChannelStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

type ChannelStatusRow = {
  label: string;
  value: unknown;
  /** Renders the value as a status dot + text instead of plain text. */
  kind?: ChannelStatusKind;
};

function resolveChannelStatus(
  key: ChannelKey,
  props: ChannelsProps,
): Record<string, unknown> | undefined {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  return channels?.[key] as Record<string, unknown> | undefined;
}

function resolveDefaultChannelAccount(
  key: ChannelKey,
  props: ChannelsProps,
): ChannelAccountSnapshot | null {
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const defaultAccountId = props.snapshot?.channelDefaultAccountId?.[key];
  return (
    (defaultAccountId
      ? accounts.find((account) => account.accountId === defaultAccountId)
      : undefined) ??
    accounts[0] ??
    null
  );
}

export function resolveChannelDisplayState(
  key: ChannelKey,
  props: ChannelsProps,
): ChannelDisplayState {
  const status = resolveChannelStatus(key, props);
  const accounts = props.snapshot?.channelAccounts?.[key] ?? [];
  const defaultAccount = resolveDefaultChannelAccount(key, props);
  const configured =
    typeof status?.configured === "boolean"
      ? status.configured
      : typeof defaultAccount?.configured === "boolean"
        ? defaultAccount.configured
        : null;
  const running = typeof status?.running === "boolean" ? status.running : null;
  const connected = typeof status?.connected === "boolean" ? status.connected : null;
  const hasAnyActiveAccount = accounts.some(
    (account) => account.configured || account.running || account.connected,
  );

  return {
    configured,
    running,
    connected,
    defaultAccount,
    hasAnyActiveAccount,
    status,
  };
}

export function channelEnabled(key: ChannelKey, props: ChannelsProps) {
  if (!props.snapshot) {
    return false;
  }
  const displayState = resolveChannelDisplayState(key, props);
  return (
    displayState.configured === true ||
    displayState.running === true ||
    displayState.connected === true ||
    displayState.hasAnyActiveAccount
  );
}

export function resolveChannelConfigured(key: ChannelKey, props: ChannelsProps): boolean | null {
  return resolveChannelDisplayState(key, props).configured;
}

export function formatNullableBoolean(value: boolean | null): string {
  if (value == null) {
    return t("common.na");
  }
  return value ? t("common.yes") : t("common.no");
}

/** Status kind for boolean facts: dot signals on, quiet dot signals off. */
export function boolStatusKind(value: boolean | null | undefined): ChannelStatusKind {
  return value === true ? "ok" : "muted";
}

/** Key/value facts grid used for channel status snapshots. */
export function renderChannelFacts(rows: readonly ChannelStatusRow[]) {
  return html`
    <dl class="settings-kv">
      ${rows.map(
        (row) => html`
          <dt>${row.label}</dt>
          <dd>
            ${row.kind !== undefined
              ? renderSettingsStatus({ kind: row.kind, label: row.value })
              : row.value}
          </dd>
        `,
      )}
    </dl>
  `;
}

/** Error row: danger dot + label, message as description. */
export function renderChannelErrorRow(message: unknown) {
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title"
          >${renderSettingsStatus({ kind: "danger", label: t("channels.lastError") })}</span
        >
        <span class="settings-row__desc">${message}</span>
      </div>
    </div>
  `;
}

/** Probe outcome row: ok/danger dot with the raw status/error detail. */
export function renderChannelProbeRow(probe: {
  ok?: boolean;
  status?: number | string | null;
  error?: string | null;
}) {
  const detail = [probe.status ?? "", probe.error ?? ""].filter(Boolean).join(" ");
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title"
          >${renderSettingsStatus({
            kind: probe.ok ? "ok" : "danger",
            label: probe.ok ? t("common.probeOk") : t("common.probeFailed"),
          })}</span
        >
        ${detail ? html`<span class="settings-row__desc">${detail}</span>` : nothing}
      </div>
    </div>
  `;
}

/** Trailing action row carrying a button cluster in the control slot. */
export function renderChannelActionRow(actions: unknown) {
  return html`
    <div class="settings-row">
      <div class="settings-row__text"></div>
      <div class="settings-row__control">${actions}</div>
    </div>
  `;
}

/** One account inside a multi-account channel group. */
export function renderChannelAccountRow(params: {
  title: unknown;
  accountId: string;
  facts?: readonly string[];
  status: { kind: ChannelStatusKind; label: unknown };
  lastInboundAt?: number | null;
  lastError?: string | null;
}) {
  const factLine = [params.accountId, ...(params.facts ?? [])].join(" · ");
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${params.title}</span>
        <span class="settings-row__desc">${factLine}</span>
        ${params.lastError
          ? html`<span class="settings-row__desc">${params.lastError}</span>`
          : nothing}
      </div>
      <div class="settings-row__control">
        ${renderSettingsStatus(params.status)}
        <span class="settings-row__value"
          >${params.lastInboundAt
            ? formatRelativeTimestamp(params.lastInboundAt)
            : t("common.na")}</span
        >
      </div>
    </div>
  `;
}

/**
 * One channel = one settings section: heading with optional account count,
 * a group holding the status facts, error/probe rows, extra content, the
 * config form, and a trailing action row.
 */
export function renderSingleAccountChannelCard(params: {
  title: string;
  subtitle: string;
  accountCount?: number;
  statusRows: readonly ChannelStatusRow[];
  lastError?: string | null;
  secondaryCallout?: unknown;
  extraContent?: unknown;
  configSection: unknown;
  footer?: unknown;
}) {
  return renderSettingsSection(
    {
      title: params.title,
      description: params.subtitle,
      ...(params.accountCount !== undefined ? { count: params.accountCount } : {}),
    },
    html`
      ${renderChannelFacts(params.statusRows)}
      ${params.lastError ? renderChannelErrorRow(params.lastError) : nothing}
      ${params.secondaryCallout ?? nothing} ${params.extraContent ?? nothing}
      ${params.configSection} ${params.footer ? renderChannelActionRow(params.footer) : nothing}
    `,
  );
}

function getChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number {
  return channelAccounts?.[key]?.length ?? 0;
}

/** Multi-account channels surface the account count next to the heading. */
export function resolveChannelAccountCount(
  key: ChannelKey,
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null,
): number | undefined {
  const count = getChannelAccountCount(key, channelAccounts);
  return count >= 2 ? count : undefined;
}
