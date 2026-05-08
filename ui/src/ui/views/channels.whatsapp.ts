import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatDurationHuman } from "../format.ts";
import type { WhatsAppStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;
  const configured = resolveChannelConfigured("whatsapp", props);
  const linked = whatsapp?.linked === true;
  const hasQr = props.whatsappQrDataUrl != null;

  return renderSingleAccountChannelCard({
    title: "WhatsApp",
    subtitle: "Link WhatsApp Web and monitor connection health.",
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      { label: t("common.linked"), value: whatsapp?.linked ? t("common.yes") : t("common.no") },
      { label: t("common.running"), value: whatsapp?.running ? t("common.yes") : t("common.no") },
      {
        label: t("common.connected"),
        value: whatsapp?.connected ? t("common.yes") : t("common.no"),
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
        ? html`<div class="callout" style="margin-top: 12px;">${props.whatsappMessage}</div>`
        : nothing}
      ${props.whatsappQrDataUrl
        ? html`<div class="qr-wrap">
            <img src=${props.whatsappQrDataUrl} alt="WhatsApp QR" />
          </div>`
        : nothing}
    `,
    configSection: renderChannelConfigSection({ channelId: "whatsapp", props }),
    footer: html`<div class="row" style="margin-top: 14px; flex-wrap: wrap;">
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
    </div>`,
  });
}
