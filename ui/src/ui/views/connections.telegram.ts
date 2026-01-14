import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type { ChannelAccountSnapshot, TelegramStatus } from "../types";
import type { ConnectionsProps } from "./connections.types";

export function renderTelegramCard(params: {
  props: ConnectionsProps;
  telegram?: TelegramStatus;
  telegramAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
}) {
  const { props, telegram, telegramAccounts, accountCountLabel } = params;
  const hasMultipleAccounts = telegramAccounts.length > 1;

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const probe = account.probe as { bot?: { username?: string } } | undefined;
    const botUsername = probe?.bot?.username;
    const label = account.name || account.accountId;
    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">
            ${botUsername ? `@${botUsername}` : label}
          </div>
          <div class="account-card-id">${account.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">Running</span>
            <span>${account.running ? "Yes" : "No"}</span>
          </div>
          <div>
            <span class="label">Configured</span>
            <span>${account.configured ? "Yes" : "No"}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${account.lastInboundAt ? formatAgo(account.lastInboundAt) : "n/a"}</span>
          </div>
          ${account.lastError
            ? html`
                <div class="account-card-error">
                  ${account.lastError}
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  };

  return html`
    <div class="card">
      <div class="card-title">Telegram</div>
      <div class="card-sub">Bot token and delivery options.</div>
      ${accountCountLabel}

      ${hasMultipleAccounts
        ? html`
            <div class="account-card-list">
              ${telegramAccounts.map((account) => renderAccountCard(account))}
            </div>
          `
        : html`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${telegram?.configured ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${telegram?.running ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Mode</span>
                <span>${telegram?.mode ?? "n/a"}</span>
              </div>
              <div>
                <span class="label">Last start</span>
                <span>${telegram?.lastStartAt ? formatAgo(telegram.lastStartAt) : "n/a"}</span>
              </div>
              <div>
                <span class="label">Last probe</span>
                <span>${telegram?.lastProbeAt ? formatAgo(telegram.lastProbeAt) : "n/a"}</span>
              </div>
            </div>
          `}

      ${telegram?.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${telegram.lastError}
          </div>`
        : nothing}

      ${telegram?.probe
        ? html`<div class="callout" style="margin-top: 12px;">
            Probe ${telegram.probe.ok ? "ok" : "failed"} ·
            ${telegram.probe.status ?? ""} ${telegram.probe.error ?? ""}
          </div>`
        : nothing}

      <div class="form-grid" style="margin-top: 16px;">
        <label class="field">
          <span>Bot token</span>
          <input
            type="password"
            .value=${props.telegramForm.token}
            ?disabled=${props.telegramTokenLocked}
            @input=${(e: Event) =>
              props.onTelegramChange({
                token: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="field">
          <span>Apply default group rules</span>
          <select
            .value=${props.telegramForm.groupsWildcardEnabled ? "yes" : "no"}
            @change=${(e: Event) =>
              props.onTelegramChange({
                groupsWildcardEnabled:
                  (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="no">No</option>
            <option value="yes">Yes (allow all groups)</option>
          </select>
        </label>
        <label class="field">
          <span>Require mention in groups</span>
          <select
            .value=${props.telegramForm.requireMention ? "yes" : "no"}
            ?disabled=${!props.telegramForm.groupsWildcardEnabled}
            @change=${(e: Event) =>
              props.onTelegramChange({
                requireMention: (e.target as HTMLSelectElement).value === "yes",
              })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="field">
          <span>Allow from</span>
          <input
            .value=${props.telegramForm.allowFrom}
            @input=${(e: Event) =>
              props.onTelegramChange({
                allowFrom: (e.target as HTMLInputElement).value,
              })}
            placeholder="123456789, @team, tg:123"
          />
        </label>
        <label class="field">
          <span>Proxy</span>
          <input
            .value=${props.telegramForm.proxy}
            @input=${(e: Event) =>
              props.onTelegramChange({
                proxy: (e.target as HTMLInputElement).value,
              })}
            placeholder="socks5://localhost:9050"
          />
        </label>
        <label class="field">
          <span>Webhook URL</span>
          <input
            .value=${props.telegramForm.webhookUrl}
            @input=${(e: Event) =>
              props.onTelegramChange({
                webhookUrl: (e.target as HTMLInputElement).value,
              })}
            placeholder="https://example.com/telegram-webhook"
          />
        </label>
        <label class="field">
          <span>Webhook secret</span>
          <input
            .value=${props.telegramForm.webhookSecret}
            @input=${(e: Event) =>
              props.onTelegramChange({
                webhookSecret: (e.target as HTMLInputElement).value,
              })}
            placeholder="secret"
          />
        </label>
        <label class="field">
          <span>Webhook path</span>
          <input
            .value=${props.telegramForm.webhookPath}
            @input=${(e: Event) =>
              props.onTelegramChange({
                webhookPath: (e.target as HTMLInputElement).value,
              })}
            placeholder="/telegram-webhook"
          />
        </label>
      </div>

      <div class="callout" style="margin-top: 12px;">
        Allow from supports numeric user IDs (recommended) or @usernames. DM the bot
        to get your ID, or run /whoami.
      </div>

      ${props.telegramTokenLocked
        ? html`<div class="callout" style="margin-top: 12px;">
            TELEGRAM_BOT_TOKEN is set in the environment. Config edits will not override it.
          </div>`
        : nothing}

      ${props.telegramForm.groupsWildcardEnabled
        ? html`<div class="callout danger" style="margin-top: 12px;">
            This writes telegram.groups["*"] and allows all groups. Remove it
            if you only want specific groups.
            <div class="row" style="margin-top: 8px;">
              <button
                class="btn"
                @click=${() => props.onTelegramChange({ groupsWildcardEnabled: false })}
              >
                Remove wildcard
              </button>
            </div>
          </div>`
        : nothing}

      ${props.telegramStatus
        ? html`<div class="callout" style="margin-top: 12px;">
            ${props.telegramStatus}
          </div>`
        : nothing}

      <div class="row" style="margin-top: 14px;">
        <button
          class="btn primary"
          ?disabled=${props.telegramSaving}
          @click=${() => props.onTelegramSave()}
        >
          ${props.telegramSaving ? "Saving…" : "Save"}
        </button>
        <button class="btn" @click=${() => props.onRefresh(true)}>
          Probe
        </button>
      </div>
    </div>
  `;
}

