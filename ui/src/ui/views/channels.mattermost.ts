import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { MattermostStatus } from "../types";
import type { ChannelsProps } from "./channels.types";
import { renderChannelConfigSection } from "./channels.config";

export function renderMattermostCard(params: {
  props: ChannelsProps;
  mattermost?: MattermostStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, mattermost, accountCountLabel } = params;

  return html`
    <div class="card">
      <div class="card-title">Mattermost</div>
      <div class="card-sub">Bot token + WebSocket status and configuration.</div>
      ${accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        <div>
          <span class="label">Configured</span>
          <span>${mattermost?.configured ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Running</span>
          <span>${mattermost?.running ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Connected</span>
          <span>${mattermost?.connected ? "Yes" : "No"}</span>
        </div>
        <div>
          <span class="label">Base URL</span>
          <span>${mattermost?.baseUrl || "n/a"}</span>
        </div>
        <div>
          <span class="label">Last start</span>
          <span>${mattermost?.lastStartAt ? formatAgo(mattermost.lastStartAt) : "n/a"}</span>
        </div>
        <div>
          <span class="label">Last probe</span>
          <span>${mattermost?.lastProbeAt ? formatAgo(mattermost.lastProbeAt) : "n/a"}</span>
        </div>
      </div>

      ${mattermost?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${mattermost.lastError}
          </div>`
        : nothing}

      ${mattermost?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${mattermost.probe.ok ? "ok" : "failed"} -
            ${mattermost.probe.status ?? ""} ${mattermost.probe.error ?? ""}
          </div>`
        : nothing}

      ${renderChannelConfigSection({ channelId: "mattermost", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(true)}>
          Probe
        </button>
      </div>
    </div>
  `;
}
