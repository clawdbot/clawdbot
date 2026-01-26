import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { WhatsAppStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { renderChannelConfigSection } from "./channels.config";
import { formatDuration } from "./channels.shared";

export function renderWhatsAppCard(params: {
  props: ChannelsProps;
  whatsapp?: WhatsAppStatus;
  accountCountLabel: unknown;
}) {
  const { props, whatsapp, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">WhatsApp</div>
      <div class="card-sub">Link WhatsApp Web and monitor connection health.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${whatsapp?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Linked</span>
          <span>${whatsapp?.linked ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${whatsapp?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${whatsapp?.connected ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Last connect</span>
          <span>
            ${whatsapp?.lastConnectedAt
              ? formatAgo(whatsapp.lastConnectedAt)
              : "n/a"}
          </span>
        </div>
        <div>
          <span class="label">Last message</span>
          <span>
            ${whatsapp?.lastMessageAt ? formatAgo(whatsapp.lastMessageAt) : "n/a"}
          </span>
        </div>
        <div>
          <span class="label">Auth age</span>
          <span>
            ${whatsapp?.authAgeMs != null
              ? formatDuration(whatsapp.authAgeMs)
              : "n/a"}
          </span>
        </div>
      </div>

      ${whatsapp?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${whatsapp.lastError}
          </div>`
        : nothing}

      ${props.whatsappMessage
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.whatsappMessage}
          </div>`
        : nothing}

      ${props.whatsappQrDataUrl
        ? html`<div class="qr-wrap">
            <img src=${props.whatsappQrDataUrl} alt="WhatsApp QR" />
          </div>`
        : nothing}

      <div class="row" style="margin-top: 14px; flex-wrap: wrap;">
        <button
          class="btn primary"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(false)}
        >
          ${props.whatsappBusy ? "Working…" : "Show QR"}
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppStart(true)}
        >
          Relink
        </button>
        <button
          class="btn"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppWait()}
        >
          Wait for scan
        </button>
        <button
          class="btn danger"
          ?disabled=${props.whatsappBusy}
          @click=${() => props.onWhatsAppLogout()}
        >
          Logout
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          Refresh
        </button>
      </div>

      ${renderChannelConfigSection({ channelId: "whatsapp", props })}
    </div>
  `;
}
