import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { GoogleChatStatus } from "../types";
import { renderChannelConfigSection } from "./channels.config";
import type { ChannelsProps } from "./channels.types";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googleChat, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Google Chat</div>
      <div class="card-sub">Chat API webhook status and channel configuration.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${googleChat ? (googleChat.configured ? "Yes" : "No") : "n/a"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${googleChat ? (googleChat.running ? "Yes" : "No") : "n/a"}</span>
        </div>
        <div>
          <span class="label">Credential</span>
          <span>${googleChat?.credentialSource ?? "n/a"}</span>
        </div>
        <div>
          <span class="label">Audience</span>
          <span>
            ${googleChat?.audienceType
              ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
              : "n/a"}
          </span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${googleChat?.lastStartAt ? formatAgo(googleChat.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${googleChat?.lastProbeAt ? formatAgo(googleChat.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${googleChat?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${googleChat.lastError}
          </div>`
        : nothing}

      ${googleChat?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${googleChat.probe.ok ? "ok" : "failed"} ·
            ${googleChat.probe.status ?? ""} ${googleChat.probe.error ?? ""}
          </div>`
        : nothing}

      ${renderChannelConfigSection({ channelId: "googlechat", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          Probe
        </button>
      </div>
    </div>
  `;
}
