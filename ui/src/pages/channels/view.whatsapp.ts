// Channels page renders WhatsApp status.
import { html, nothing } from "lit";
import type { WhatsAppStatus } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../../lib/format.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCount?: number;
}) {
  const { props, whatsapp, accountCount } = params;
  const configured = resolveChannelConfigured("whatsapp", props);
  const linked = whatsapp?.linked === true;
  const hasQr = props.whatsappQrDataUrl != null;

  return renderSingleAccountChannelCard({
    title: t("channels.whatsapp.title"),
    subtitle: t("channels.whatsapp.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.linked"),
        value: whatsapp?.linked ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(whatsapp?.linked),
      },
      {
        label: t("common.running"),
        value: whatsapp?.running ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(whatsapp?.running),
      },
      {
        label: t("common.connected"),
        value: whatsapp?.connected ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(whatsapp?.connected),
      },
      {
        label: t("common.lastConnect"),
        value: whatsapp?.lastConnectedAt
          ? formatRelativeTimestamp(whatsapp.lastConnectedAt)
          : t("common.na"),
      },
      {
        label: t("common.lastMessage"),
        value: whatsapp?.lastMessageAt
          ? formatRelativeTimestamp(whatsapp.lastMessageAt)
          : t("common.na"),
      },
      {
        label: t("common.authAge"),
        value:
          whatsapp?.authAgeMs != null ? formatDurationHuman(whatsapp.authAgeMs) : t("common.na"),
      },
    ],
    lastError: whatsapp?.lastError,
    extraContent: html`
      ${props.whatsappMessage
        ? html`
            <div class="settings-row">
              <div class="settings-row__text">
                <span class="settings-row__desc">${props.whatsappMessage}</span>
              </div>
            </div>
          `
        : nothing}
      ${props.whatsappQrDataUrl
        ? html`
            <div class="settings-row settings-row--stacked">
              <div class="qr-wrap">
                <img src=${props.whatsappQrDataUrl} alt="WhatsApp QR" />
              </div>
            </div>
          `
        : nothing}
    `,
    configSection: renderChannelConfigSection({ channelId: "whatsapp", props }),
    footer: html`
      ${linked
        ? html`<button
            class="btn"
            ?disabled=${props.whatsappBusy}
            @click=${() => props.onWhatsAppStart(true)}
          >
            ${t("common.relink")}
          </button>`
        : html`<button
            class="btn primary"
            ?disabled=${props.whatsappBusy}
            @click=${() => props.onWhatsAppStart(false)}
          >
            ${props.whatsappBusy ? t("common.working") : t("common.showQr")}
          </button>`}
      ${hasQr
        ? html`<button
            class="btn"
            ?disabled=${props.whatsappBusy}
            @click=${() => props.onWhatsAppWait()}
          >
            ${t("common.waitForScan")}
          </button>`
        : nothing}
      <button
        class="btn danger"
        ?disabled=${props.whatsappBusy}
        @click=${() => props.onWhatsAppLogout()}
      >
        ${t("common.logout")}
      </button>
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.refresh")}</button>
    `,
  });
}
