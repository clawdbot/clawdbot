// Channels page renders Telegram status.
import { html, nothing } from "lit";
import type { ChannelAccountSnapshot, TelegramStatus } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

export function renderTelegramCard(params: {
  props: ChannelsProps;
  telegram?: TelegramStatus;
  telegramAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, telegram, telegramAccounts, accountCountLabel } = params;
  const hasMultipleAccounts = telegramAccounts.length > 1;
  const configured = resolveChannelConfigured("telegram", props);

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const probe = account.probe as { bot?: { username?: string } } | undefined;
    const botUsername = probe?.bot?.username;
    const label = account.name || account.accountId;
    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${botUsername ? `@${botUsername}` : label}</div>
          <div class="account-card-id">${account.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${t("common.running")}</span>
            <span>${account.running ? t("common.yes") : t("common.no")}</span>
          </div>
          <div>
            <span class="label">${t("common.configured")}</span>
            <span>${account.configured ? t("common.yes") : t("common.no")}</span>
          </div>
          <div>
            <span class="label">${t("common.lastInbound")}</span>
            <span
              >${account.lastInboundAt
                ? formatRelativeTimestamp(account.lastInboundAt)
                : t("common.na")}</span
            >
          </div>
          ${account.lastError
            ? html` <div class="account-card-error">${account.lastError}</div> `
            : nothing}
        </div>
      </div>
    `;
  };

  if (hasMultipleAccounts) {
    return html`
      <div class="card">
        <div class="card-title">${t("channels.telegram.title")}</div>
        <div class="card-sub">${t("channels.telegram.subtitle")}</div>
        ${accountCountLabel}

        <div class="account-card-list">
          ${telegramAccounts.map((account) => renderAccountCard(account))}
        </div>

        ${telegram?.lastError
          ? html`<div class="callout danger" style="margin-top: 12px;">${telegram.lastError}</div>`
          : nothing}
        ${telegram?.probe
          ? html`<div class="callout" style="margin-top: 12px;">
              ${telegram.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
              ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
            </div>`
          : nothing}
        ${renderChannelConfigSection({ channelId: "telegram", props })}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
        </div>
      </div>
    `;
  }

  return renderSingleAccountChannelCard({
    title: t("channels.telegram.title"),
    subtitle: t("channels.telegram.subtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      { label: t("common.running"), value: telegram?.running ? t("common.yes") : t("common.no") },
      { label: t("common.mode"), value: telegram?.mode ?? t("common.na") },
      {
        label: t("common.lastStart"),
        value: telegram?.lastStartAt
          ? formatRelativeTimestamp(telegram.lastStartAt)
          : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: telegram?.lastProbeAt
          ? formatRelativeTimestamp(telegram.lastProbeAt)
          : t("common.na"),
      },
    ],
    lastError: telegram?.lastError,
    secondaryCallout: telegram?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${telegram.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
          ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "telegram", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}
