import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type {
  DiscordStatus,
  IMessageStatus,
  ProvidersStatusSnapshot,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types";
import type {
  DiscordActionForm,
  DiscordForm,
  IMessageForm,
  SlackActionForm,
  SlackForm,
  SignalForm,
  TelegramForm,
} from "../ui-types";

const discordActionOptions = [
  { key: "reactions", label: "Reactions" },
  { key: "stickers", label: "Stickers" },
  { key: "polls", label: "Polls" },
  { key: "permissions", label: "Permissions" },
  { key: "messages", label: "Messages" },
  { key: "threads", label: "Threads" },
  { key: "pins", label: "Pins" },
  { key: "search", label: "Search" },
  { key: "memberInfo", label: "Member info" },
  { key: "roleInfo", label: "Role info" },
  { key: "channelInfo", label: "Channel info" },
  { key: "voiceStatus", label: "Voice status" },
  { key: "events", label: "Events" },
  { key: "roles", label: "Role changes" },
  { key: "moderation", label: "Moderation" },
] satisfies Array<{ key: keyof DiscordActionForm; label: string }>;

const slackActionOptions = [
  { key: "reactions", label: "Reactions" },
  { key: "messages", label: "Messages" },
  { key: "pins", label: "Pins" },
  { key: "memberInfo", label: "Member info" },
  { key: "emojiList", label: "Emoji list" },
] satisfies Array<{ key: keyof SlackActionForm; label: string }>;

export type ConnectionsProps = {
  connected: boolean;
  loading: boolean;
  snapshot: ProvidersStatusSnapshot | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  whatsappMessage: string | null;
  whatsappQrDataUrl: string | null;
  whatsappConnected: boolean | null;
  whatsappBusy: boolean;
  telegramForm: TelegramForm;
  telegramTokenLocked: boolean;
  telegramSaving: boolean;
  telegramStatus: string | null;
  discordForm: DiscordForm;
  discordTokenLocked: boolean;
  discordSaving: boolean;
  discordStatus: string | null;
  slackForm: SlackForm;
  slackTokenLocked: boolean;
  slackAppTokenLocked: boolean;
  slackSaving: boolean;
  slackStatus: string | null;
  signalForm: SignalForm;
  signalSaving: boolean;
  signalStatus: string | null;
  imessageForm: IMessageForm;
  imessageSaving: boolean;
  imessageStatus: string | null;
  onRefresh: (probe: boolean) => void;
  onWhatsAppStart: (force: boolean) => void;
  onWhatsAppWait: () => void;
  onWhatsAppLogout: () => void;
  onTelegramChange: (patch: Partial<TelegramForm>) => void;
  onTelegramSave: () => void;
  onDiscordChange: (patch: Partial<DiscordForm>) => void;
  onDiscordSave: () => void;
  onSlackChange: (patch: Partial<SlackForm>) => void;
  onSlackSave: () => void;
  onSignalChange: (patch: Partial<SignalForm>) => void;
  onSignalSave: () => void;
  onIMessageChange: (patch: Partial<IMessageForm>) => void;
  onIMessageSave: () => void;
};

export function renderConnections(props: ConnectionsProps) {
  const providers = props.snapshot?.providers as Record<string, unknown> | null;
  const whatsapp = (providers?.whatsapp ?? undefined) as
    | WhatsAppStatus
    | undefined;
  const telegram = (providers?.telegram ?? undefined) as
    | TelegramStatus
    | undefined;
  const discord = (providers?.discord ?? null) as DiscordStatus | null;
  const slack = (providers?.slack ?? null) as SlackStatus | null;
  const signal = (providers?.signal ?? null) as SignalStatus | null;
  const imessage = (providers?.imessage ?? null) as IMessageStatus | null;
  const providerOrder: ProviderKey[] = [
    "whatsapp",
    "telegram",
    "discord",
    "slack",
    "signal",
    "imessage",
  ];
  const orderedProviders = providerOrder
    .map((key, index) => ({
      key,
      enabled: providerEnabled(key, props),
      order: index,
    }))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.order - b.order;
    });

  return html`
    <section class="grid grid-cols-2">
      ${orderedProviders.map((provider) =>
        renderProvider(provider.key, props, {
          whatsapp,
          telegram,
          discord,
          slack,
          signal,
          imessage,
        }),
      )}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Connection health</div>
          <div class="card-sub">Provider status snapshots from the gateway.</div>
        </div>
        <div class="muted">${props.lastSuccessAt ? formatAgo(props.lastSuccessAt) : "n/a"}</div>
      </div>
      ${props.lastError
        ? html`<div class="callout danger" style="margin-top: 12px;">
            ${props.lastError}
          </div>`
        : nothing}
      <pre class="code-block" style="margin-top: 12px;">
${props.snapshot ? JSON.stringify(props.snapshot, null, 2) : "No snapshot yet."}
      </pre>
    </section>
  `;
}

function formatDuration(ms?: number | null) {
  if (!ms && ms !== 0) return "n/a";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}

type ProviderKey =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "signal"
  | "imessage";

function providerEnabled(key: ProviderKey, props: ConnectionsProps) {
  const snapshot = props.snapshot;
  const providers = snapshot?.providers as Record<string, unknown> | null;
  if (!snapshot || !providers) return false;
  const whatsapp = providers.whatsapp as WhatsAppStatus | undefined;
  const telegram = providers.telegram as TelegramStatus | undefined;
  const discord = (providers.discord ?? null) as DiscordStatus | null;
  const slack = (providers.slack ?? null) as SlackStatus | null;
  const signal = (providers.signal ?? null) as SignalStatus | null;
  const imessage = (providers.imessage ?? null) as IMessageStatus | null;
  switch (key) {
    case "whatsapp":
      return (
        Boolean(whatsapp?.configured) ||
        Boolean(whatsapp?.linked) ||
        Boolean(whatsapp?.running)
      );
    case "telegram":
      return Boolean(telegram?.configured) || Boolean(telegram?.running);
    case "discord":
      return Boolean(discord?.configured || discord?.running);
    case "slack":
      return Boolean(slack?.configured || slack?.running);
    case "signal":
      return Boolean(signal?.configured || signal?.running);
    case "imessage":
      return Boolean(imessage?.configured || imessage?.running);
    default:
      return false;
  }
}

function renderProvider(
  key: ProviderKey,
  props: ConnectionsProps,
  data: {
    whatsapp?: WhatsAppStatus;
    telegram?: TelegramStatus;
    discord?: DiscordStatus | null;
    slack?: SlackStatus | null;
    signal?: SignalStatus | null;
    imessage?: IMessageStatus | null;
  },
) {
  switch (key) {
    case "whatsapp": {
      const whatsapp = data.whatsapp;
      return html`
        <div class="card">
          <div class="card-title">WhatsApp</div>
          <div class="card-sub">Link WhatsApp Web and monitor connection health.</div>

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
                ${whatsapp?.authAgeMs != null ? formatDuration(whatsapp.authAgeMs) : "n/a"}
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
        </div>
      `;
    }
    case "telegram": {
      const telegram = data.telegram;
      return html`
        <div class="card">
          <div class="card-title">Telegram</div>
          <div class="card-sub">Bot token and delivery options.</div>

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

          ${telegram?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
                ${telegram.lastError}
              </div>`
            : nothing}

          ${telegram?.probe
            ? html`<div class="callout" style="margin-top: 12px;">
                Probe ${telegram.probe.ok ? "ok" : "failed"} ·
                ${telegram.probe.status ?? ""}
                ${telegram.probe.error ?? ""}
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
                    @click=${() =>
                      props.onTelegramChange({ groupsWildcardEnabled: false })}
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
    case "discord": {
      const discord = data.discord;
      const botName = discord?.probe?.bot?.username;
      return html`
        <div class="card">
          <div class="card-title">Discord</div>
          <div class="card-sub">Bot connection and probe status.</div>

          <div class="status-list" style="margin-top: 16px;">
            <div>
              <span class="label">Configured</span>
              <span>${discord?.configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${discord?.running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Bot</span>
              <span>${botName ? `@${botName}` : "n/a"}</span>
            </div>
            <div>
              <span class="label">Last start</span>
              <span>${discord?.lastStartAt ? formatAgo(discord.lastStartAt) : "n/a"}</span>
            </div>
            <div>
              <span class="label">Last probe</span>
              <span>${discord?.lastProbeAt ? formatAgo(discord.lastProbeAt) : "n/a"}</span>
            </div>
          </div>

          ${discord?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
                ${discord.lastError}
              </div>`
            : nothing}

          ${discord?.probe
            ? html`<div class="callout" style="margin-top: 12px;">
                Probe ${discord.probe.ok ? "ok" : "failed"} ·
                ${discord.probe.status ?? ""}
                ${discord.probe.error ?? ""}
              </div>`
            : nothing}

          <div class="form-grid" style="margin-top: 16px;">
            <label class="field">
              <span>Enabled</span>
              <select
                .value=${props.discordForm.enabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onDiscordChange({
                    enabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Bot token</span>
              <input
                type="password"
                .value=${props.discordForm.token}
                ?disabled=${props.discordTokenLocked}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    token: (e.target as HTMLInputElement).value,
                  })}
              />
            </label>
            <label class="field">
              <span>Allow DMs from</span>
              <input
                .value=${props.discordForm.allowFrom}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    allowFrom: (e.target as HTMLInputElement).value,
                  })}
                placeholder="123456789, username#1234"
              />
            </label>
            <label class="field">
              <span>DMs enabled</span>
              <select
                .value=${props.discordForm.dmEnabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onDiscordChange({
                    dmEnabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Enabled</option>
                <option value="no">Disabled</option>
              </select>
            </label>
            <label class="field">
              <span>Group DMs</span>
              <select
                .value=${props.discordForm.groupEnabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onDiscordChange({
                    groupEnabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Enabled</option>
                <option value="no">Disabled</option>
              </select>
            </label>
            <label class="field">
              <span>Group channels</span>
              <input
                .value=${props.discordForm.groupChannels}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    groupChannels: (e.target as HTMLInputElement).value,
                  })}
                placeholder="channelId1, channelId2"
              />
            </label>
            <label class="field">
              <span>Media max MB</span>
              <input
                .value=${props.discordForm.mediaMaxMb}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    mediaMaxMb: (e.target as HTMLInputElement).value,
                  })}
                placeholder="8"
              />
            </label>
            <label class="field">
              <span>History limit</span>
              <input
                .value=${props.discordForm.historyLimit}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    historyLimit: (e.target as HTMLInputElement).value,
                  })}
                placeholder="20"
              />
            </label>
            <label class="field">
              <span>Text chunk limit</span>
              <input
                .value=${props.discordForm.textChunkLimit}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    textChunkLimit: (e.target as HTMLInputElement).value,
                  })}
                placeholder="2000"
              />
            </label>
            <label class="field">
              <span>Reply to mode</span>
              <select
                .value=${props.discordForm.replyToMode}
                @change=${(e: Event) =>
                  props.onDiscordChange({
                    replyToMode: (e.target as HTMLSelectElement).value as
                      | "off"
                      | "first"
                      | "all",
                  })}
              >
                <option value="off">Off</option>
                <option value="first">First</option>
                <option value="all">All</option>
              </select>
            </label>
            <div class="field full">
              <span>Guilds</span>
              <div class="card-sub">
                Add each guild (id or slug) and optional channel rules. Empty channel
                entries still allow that channel.
              </div>
              <div class="list">
                ${props.discordForm.guilds.map(
                  (guild, guildIndex) => html`
                    <div class="list-item">
                      <div class="list-main">
                        <div class="form-grid">
                          <label class="field">
                            <span>Guild id / slug</span>
                            <input
                            .value=${guild.key}
                            @input=${(e: Event) => {
                              const next = [...props.discordForm.guilds];
                              next[guildIndex] = {
                                ...next[guildIndex],
                                key: (e.target as HTMLInputElement).value,
                              };
                              props.onDiscordChange({ guilds: next });
                            }}
                          />
                        </label>
                        <label class="field">
                          <span>Slug</span>
                          <input
                            .value=${guild.slug}
                            @input=${(e: Event) => {
                              const next = [...props.discordForm.guilds];
                              next[guildIndex] = {
                                ...next[guildIndex],
                                slug: (e.target as HTMLInputElement).value,
                              };
                              props.onDiscordChange({ guilds: next });
                            }}
                          />
                        </label>
                        <label class="field">
                          <span>Require mention</span>
                          <select
                            .value=${guild.requireMention ? "yes" : "no"}
                            @change=${(e: Event) => {
                              const next = [...props.discordForm.guilds];
                              next[guildIndex] = {
                                ...next[guildIndex],
                                requireMention:
                                  (e.target as HTMLSelectElement).value === "yes",
                              };
                              props.onDiscordChange({ guilds: next });
                            }}
                          >
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                          </select>
                        </label>
                        <label class="field">
                          <span>Reaction notifications</span>
                          <select
                            .value=${guild.reactionNotifications}
                            @change=${(e: Event) => {
                              const next = [...props.discordForm.guilds];
                              next[guildIndex] = {
                                ...next[guildIndex],
                                reactionNotifications: (e.target as HTMLSelectElement)
                                  .value as "off" | "own" | "all" | "allowlist",
                              };
                              props.onDiscordChange({ guilds: next });
                            }}
                          >
                            <option value="off">Off</option>
                            <option value="own">Own</option>
                            <option value="all">All</option>
                            <option value="allowlist">Allowlist</option>
                          </select>
                        </label>
                        <label class="field">
                          <span>Users allowlist</span>
                          <input
                            .value=${guild.users}
                            @input=${(e: Event) => {
                              const next = [...props.discordForm.guilds];
                              next[guildIndex] = {
                                ...next[guildIndex],
                                users: (e.target as HTMLInputElement).value,
                              };
                              props.onDiscordChange({ guilds: next });
                            }}
                            placeholder="123456789, username#1234"
                          />
                        </label>
                        </div>
                        ${guild.channels.length
                          ? html`
                              <div class="form-grid" style="margin-top: 8px;">
                                ${guild.channels.map(
                                  (channel, channelIndex) => html`
                                    <label class="field">
                                      <span>Channel id / slug</span>
                                      <input
                                        .value=${channel.key}
                                        @input=${(e: Event) => {
                                          const next = [...props.discordForm.guilds];
                                          const channels = [
                                            ...(next[guildIndex].channels ?? []),
                                          ];
                                          channels[channelIndex] = {
                                            ...channels[channelIndex],
                                            key: (e.target as HTMLInputElement).value,
                                          };
                                          next[guildIndex] = {
                                            ...next[guildIndex],
                                            channels,
                                          };
                                          props.onDiscordChange({ guilds: next });
                                        }}
                                      />
                                    </label>
                                    <label class="field">
                                      <span>Allow</span>
                                      <select
                                        .value=${channel.allow ? "yes" : "no"}
                                        @change=${(e: Event) => {
                                          const next = [...props.discordForm.guilds];
                                          const channels = [
                                            ...(next[guildIndex].channels ?? []),
                                          ];
                                          channels[channelIndex] = {
                                            ...channels[channelIndex],
                                            allow:
                                              (e.target as HTMLSelectElement).value ===
                                              "yes",
                                          };
                                          next[guildIndex] = {
                                            ...next[guildIndex],
                                            channels,
                                          };
                                          props.onDiscordChange({ guilds: next });
                                        }}
                                      >
                                        <option value="yes">Yes</option>
                                        <option value="no">No</option>
                                      </select>
                                    </label>
                                    <label class="field">
                                      <span>Require mention</span>
                                      <select
                                        .value=${channel.requireMention ? "yes" : "no"}
                                        @change=${(e: Event) => {
                                          const next = [...props.discordForm.guilds];
                                          const channels = [
                                            ...(next[guildIndex].channels ?? []),
                                          ];
                                          channels[channelIndex] = {
                                            ...channels[channelIndex],
                                            requireMention:
                                              (e.target as HTMLSelectElement).value ===
                                              "yes",
                                          };
                                          next[guildIndex] = {
                                            ...next[guildIndex],
                                            channels,
                                          };
                                          props.onDiscordChange({ guilds: next });
                                        }}
                                      >
                                        <option value="yes">Yes</option>
                                        <option value="no">No</option>
                                      </select>
                                    </label>
                                    <label class="field">
                                      <span>&nbsp;</span>
                                      <button
                                        class="btn"
                                        @click=${() => {
                                          const next = [
                                            ...props.discordForm.guilds,
                                          ];
                                          const channels = [
                                            ...(next[guildIndex].channels ?? []),
                                          ];
                                          channels.splice(channelIndex, 1);
                                          next[guildIndex] = {
                                            ...next[guildIndex],
                                            channels,
                                          };
                                          props.onDiscordChange({ guilds: next });
                                        }}
                                      >
                                        Remove
                                      </button>
                                    </label>
                                  `,
                                )}
                              </div>
                            `
                          : nothing}
                      </div>
                      <div class="list-meta">
                        <span>Channels</span>
                        <button
                          class="btn"
                          @click=${() => {
                            const next = [...props.discordForm.guilds];
                            const channels = [
                              ...(next[guildIndex].channels ?? []),
                              { key: "", allow: true, requireMention: false },
                            ];
                            next[guildIndex] = {
                              ...next[guildIndex],
                              channels,
                            };
                            props.onDiscordChange({ guilds: next });
                          }}
                        >
                          Add channel
                        </button>
                        <button
                          class="btn danger"
                          @click=${() => {
                            const next = [...props.discordForm.guilds];
                            next.splice(guildIndex, 1);
                            props.onDiscordChange({ guilds: next });
                          }}
                        >
                          Remove guild
                        </button>
                      </div>
                    </div>
                  `,
                )}
              </div>
              <button
                class="btn"
                style="margin-top: 8px;"
                @click=${() =>
                  props.onDiscordChange({
                    guilds: [
                      ...props.discordForm.guilds,
                      {
                        key: "",
                        slug: "",
                        requireMention: false,
                        reactionNotifications: "own",
                        users: "",
                        channels: [],
                      },
                    ],
                  })}
              >
                Add guild
              </button>
            </div>
            <label class="field">
              <span>Slash command</span>
              <select
                .value=${props.discordForm.slashEnabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onDiscordChange({
                    slashEnabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Enabled</option>
                <option value="no">Disabled</option>
              </select>
            </label>
            <label class="field">
              <span>Slash name</span>
              <input
                .value=${props.discordForm.slashName}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    slashName: (e.target as HTMLInputElement).value,
                  })}
                placeholder="clawd"
              />
            </label>
            <label class="field">
              <span>Slash session prefix</span>
              <input
                .value=${props.discordForm.slashSessionPrefix}
                @input=${(e: Event) =>
                  props.onDiscordChange({
                    slashSessionPrefix: (e.target as HTMLInputElement).value,
                  })}
                placeholder="discord:slash"
              />
            </label>
            <label class="field">
              <span>Slash ephemeral</span>
              <select
                .value=${props.discordForm.slashEphemeral ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onDiscordChange({
                    slashEphemeral: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
          </div>

          <div class="card-sub" style="margin-top: 16px;">Tool actions</div>
          <div class="form-grid" style="margin-top: 8px;">
            ${discordActionOptions.map(
              (action) => html`<label class="field">
                <span>${action.label}</span>
                <select
                  .value=${props.discordForm.actions[action.key] ? "yes" : "no"}
                  @change=${(e: Event) =>
                    props.onDiscordChange({
                      actions: {
                        ...props.discordForm.actions,
                        [action.key]: (e.target as HTMLSelectElement).value === "yes",
                      },
                    })}
                >
                  <option value="yes">Enabled</option>
                  <option value="no">Disabled</option>
                </select>
              </label>`,
            )}
          </div>

          ${props.discordTokenLocked
            ? html`<div class="callout" style="margin-top: 12px;">
                DISCORD_BOT_TOKEN is set in the environment. Config edits will not override it.
              </div>`
            : nothing}

          ${props.discordStatus
            ? html`<div class="callout" style="margin-top: 12px;">
                ${props.discordStatus}
              </div>`
            : nothing}

          <div class="row" style="margin-top: 14px;">
            <button
              class="btn primary"
              ?disabled=${props.discordSaving}
              @click=${() => props.onDiscordSave()}
            >
              ${props.discordSaving ? "Saving…" : "Save"}
            </button>
            <button class="btn" @click=${() => props.onRefresh(true)}>
              Probe
            </button>
          </div>
        </div>
      `;
    }
    case "slack": {
      const slack = data.slack;
      const botName = slack?.probe?.bot?.name;
      const teamName = slack?.probe?.team?.name;
      return html`
        <div class="card">
          <div class="card-title">Slack</div>
          <div class="card-sub">Socket mode status and bot details.</div>

          <div class="status-list" style="margin-top: 16px;">
            <div>
              <span class="label">Configured</span>
              <span>${slack?.configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${slack?.running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Bot</span>
              <span>${botName ? botName : "n/a"}</span>
            </div>
            <div>
              <span class="label">Team</span>
              <span>${teamName ? teamName : "n/a"}</span>
            </div>
            <div>
              <span class="label">Last start</span>
              <span>${slack?.lastStartAt ? formatAgo(slack.lastStartAt) : "n/a"}</span>
            </div>
            <div>
              <span class="label">Last probe</span>
              <span>${slack?.lastProbeAt ? formatAgo(slack.lastProbeAt) : "n/a"}</span>
            </div>
          </div>

          ${slack?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
                ${slack.lastError}
              </div>`
            : nothing}

          ${slack?.probe
            ? html`<div class="callout" style="margin-top: 12px;">
                Probe ${slack.probe.ok ? "ok" : "failed"} ·
                ${slack.probe.status ?? ""}
                ${slack.probe.error ?? ""}
              </div>`
            : nothing}

          <div class="form-grid" style="margin-top: 16px;">
            <label class="field">
              <span>Enabled</span>
              <select
                .value=${props.slackForm.enabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSlackChange({
                    enabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Bot token</span>
              <input
                type="password"
                .value=${props.slackForm.botToken}
                ?disabled=${props.slackTokenLocked}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    botToken: (e.target as HTMLInputElement).value,
                  })}
              />
            </label>
            <label class="field">
              <span>App token</span>
              <input
                type="password"
                .value=${props.slackForm.appToken}
                ?disabled=${props.slackAppTokenLocked}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    appToken: (e.target as HTMLInputElement).value,
                  })}
              />
            </label>
            <label class="field">
              <span>DMs enabled</span>
              <select
                .value=${props.slackForm.dmEnabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSlackChange({
                    dmEnabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Enabled</option>
                <option value="no">Disabled</option>
              </select>
            </label>
            <label class="field">
              <span>Allow DMs from</span>
              <input
                .value=${props.slackForm.allowFrom}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    allowFrom: (e.target as HTMLInputElement).value,
                  })}
                placeholder="U123, U456, *"
              />
            </label>
            <label class="field">
              <span>Group DMs enabled</span>
              <select
                .value=${props.slackForm.groupEnabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSlackChange({
                    groupEnabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Enabled</option>
                <option value="no">Disabled</option>
              </select>
            </label>
            <label class="field">
              <span>Group DM channels</span>
              <input
                .value=${props.slackForm.groupChannels}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    groupChannels: (e.target as HTMLInputElement).value,
                  })}
                placeholder="G123, #team"
              />
            </label>
            <label class="field">
              <span>Reaction notifications</span>
              <select
                .value=${props.slackForm.reactionNotifications}
                @change=${(e: Event) =>
                  props.onSlackChange({
                    reactionNotifications: (e.target as HTMLSelectElement)
                      .value as "off" | "own" | "all" | "allowlist",
                  })}
              >
                <option value="off">Off</option>
                <option value="own">Own</option>
                <option value="all">All</option>
                <option value="allowlist">Allowlist</option>
              </select>
            </label>
            <label class="field">
              <span>Reaction allowlist</span>
              <input
                .value=${props.slackForm.reactionAllowlist}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    reactionAllowlist: (e.target as HTMLInputElement).value,
                  })}
                placeholder="U123, U456"
              />
            </label>
            <label class="field">
              <span>Text chunk limit</span>
              <input
                .value=${props.slackForm.textChunkLimit}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    textChunkLimit: (e.target as HTMLInputElement).value,
                  })}
                placeholder="4000"
              />
            </label>
            <label class="field">
              <span>Media max (MB)</span>
              <input
                .value=${props.slackForm.mediaMaxMb}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    mediaMaxMb: (e.target as HTMLInputElement).value,
                  })}
                placeholder="20"
              />
            </label>
          </div>

          <div class="card-sub" style="margin-top: 16px;">Slash command</div>
          <div class="form-grid" style="margin-top: 8px;">
            <label class="field">
              <span>Slash enabled</span>
              <select
                .value=${props.slackForm.slashEnabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSlackChange({
                    slashEnabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Enabled</option>
                <option value="no">Disabled</option>
              </select>
            </label>
            <label class="field">
              <span>Slash name</span>
              <input
                .value=${props.slackForm.slashName}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    slashName: (e.target as HTMLInputElement).value,
                  })}
                placeholder="clawd"
              />
            </label>
            <label class="field">
              <span>Slash session prefix</span>
              <input
                .value=${props.slackForm.slashSessionPrefix}
                @input=${(e: Event) =>
                  props.onSlackChange({
                    slashSessionPrefix: (e.target as HTMLInputElement).value,
                  })}
                placeholder="slack:slash"
              />
            </label>
            <label class="field">
              <span>Slash ephemeral</span>
              <select
                .value=${props.slackForm.slashEphemeral ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSlackChange({
                    slashEphemeral: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
          </div>

          <div class="card-sub" style="margin-top: 16px;">Channels</div>
          <div class="card-sub">
            Add channel ids or #names and optionally require mentions.
          </div>
          <div class="list">
            ${props.slackForm.channels.map(
              (channel, channelIndex) => html`
                <div class="list-item">
                  <div class="list-main">
                    <div class="form-grid">
                      <label class="field">
                        <span>Channel id / name</span>
                        <input
                          .value=${channel.key}
                          @input=${(e: Event) => {
                            const next = [...props.slackForm.channels];
                            next[channelIndex] = {
                              ...next[channelIndex],
                              key: (e.target as HTMLInputElement).value,
                            };
                            props.onSlackChange({ channels: next });
                          }}
                        />
                      </label>
                      <label class="field">
                        <span>Allow</span>
                        <select
                          .value=${channel.allow ? "yes" : "no"}
                          @change=${(e: Event) => {
                            const next = [...props.slackForm.channels];
                            next[channelIndex] = {
                              ...next[channelIndex],
                              allow:
                                (e.target as HTMLSelectElement).value === "yes",
                            };
                            props.onSlackChange({ channels: next });
                          }}
                        >
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </label>
                      <label class="field">
                        <span>Require mention</span>
                        <select
                          .value=${channel.requireMention ? "yes" : "no"}
                          @change=${(e: Event) => {
                            const next = [...props.slackForm.channels];
                            next[channelIndex] = {
                              ...next[channelIndex],
                              requireMention:
                                (e.target as HTMLSelectElement).value === "yes",
                            };
                            props.onSlackChange({ channels: next });
                          }}
                        >
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </label>
                      <label class="field">
                        <span>&nbsp;</span>
                        <button
                          class="btn"
                          @click=${() => {
                            const next = [...props.slackForm.channels];
                            next.splice(channelIndex, 1);
                            props.onSlackChange({ channels: next });
                          }}
                        >
                          Remove
                        </button>
                      </label>
                    </div>
                  </div>
                </div>
              `,
            )}
          </div>
          <button
            class="btn"
            style="margin-top: 8px;"
            @click=${() =>
              props.onSlackChange({
                channels: [
                  ...props.slackForm.channels,
                  { key: "", allow: true, requireMention: false },
                ],
              })}
          >
            Add channel
          </button>

          <div class="card-sub" style="margin-top: 16px;">Tool actions</div>
          <div class="form-grid" style="margin-top: 8px;">
            ${slackActionOptions.map(
              (action) => html`<label class="field">
                <span>${action.label}</span>
                <select
                  .value=${props.slackForm.actions[action.key] ? "yes" : "no"}
                  @change=${(e: Event) =>
                    props.onSlackChange({
                      actions: {
                        ...props.slackForm.actions,
                        [action.key]: (e.target as HTMLSelectElement).value === "yes",
                      },
                    })}
                >
                  <option value="yes">Enabled</option>
                  <option value="no">Disabled</option>
                </select>
              </label>`,
            )}
          </div>

          ${props.slackTokenLocked || props.slackAppTokenLocked
            ? html`<div class="callout" style="margin-top: 12px;">
                ${props.slackTokenLocked ? "SLACK_BOT_TOKEN " : ""}
                ${props.slackAppTokenLocked ? "SLACK_APP_TOKEN " : ""}
                is set in the environment. Config edits will not override it.
              </div>`
            : nothing}

          ${props.slackStatus
            ? html`<div class="callout" style="margin-top: 12px;">
                ${props.slackStatus}
              </div>`
            : nothing}

          <div class="row" style="margin-top: 14px;">
            <button
              class="btn primary"
              ?disabled=${props.slackSaving}
              @click=${() => props.onSlackSave()}
            >
              ${props.slackSaving ? "Saving…" : "Save"}
            </button>
            <button class="btn" @click=${() => props.onRefresh(true)}>
              Probe
            </button>
          </div>
        </div>
      `;
    }
    case "signal": {
      const signal = data.signal;
      return html`
        <div class="card">
          <div class="card-title">Signal</div>
          <div class="card-sub">REST daemon status and probe details.</div>

          <div class="status-list" style="margin-top: 16px;">
            <div>
              <span class="label">Configured</span>
              <span>${signal?.configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${signal?.running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Base URL</span>
              <span>${signal?.baseUrl ?? "n/a"}</span>
            </div>
            <div>
              <span class="label">Last start</span>
              <span>${signal?.lastStartAt ? formatAgo(signal.lastStartAt) : "n/a"}</span>
            </div>
            <div>
              <span class="label">Last probe</span>
              <span>${signal?.lastProbeAt ? formatAgo(signal.lastProbeAt) : "n/a"}</span>
            </div>
          </div>

          ${signal?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
                ${signal.lastError}
              </div>`
            : nothing}

          ${signal?.probe
            ? html`<div class="callout" style="margin-top: 12px;">
                Probe ${signal.probe.ok ? "ok" : "failed"} ·
                ${signal.probe.status ?? ""}
                ${signal.probe.error ?? ""}
              </div>`
            : nothing}

          <div class="form-grid" style="margin-top: 16px;">
            <label class="field">
              <span>Enabled</span>
              <select
                .value=${props.signalForm.enabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSignalChange({
                    enabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Account</span>
              <input
                .value=${props.signalForm.account}
                @input=${(e: Event) =>
                  props.onSignalChange({
                    account: (e.target as HTMLInputElement).value,
                  })}
                placeholder="+15551234567"
              />
            </label>
            <label class="field">
              <span>HTTP URL</span>
              <input
                .value=${props.signalForm.httpUrl}
                @input=${(e: Event) =>
                  props.onSignalChange({
                    httpUrl: (e.target as HTMLInputElement).value,
                  })}
                placeholder="http://127.0.0.1:8080"
              />
            </label>
            <label class="field">
              <span>HTTP host</span>
              <input
                .value=${props.signalForm.httpHost}
                @input=${(e: Event) =>
                  props.onSignalChange({
                    httpHost: (e.target as HTMLInputElement).value,
                  })}
                placeholder="127.0.0.1"
              />
            </label>
            <label class="field">
              <span>HTTP port</span>
              <input
                .value=${props.signalForm.httpPort}
                @input=${(e: Event) =>
                  props.onSignalChange({
                    httpPort: (e.target as HTMLInputElement).value,
                  })}
                placeholder="8080"
              />
            </label>
            <label class="field">
              <span>CLI path</span>
              <input
                .value=${props.signalForm.cliPath}
                @input=${(e: Event) =>
                  props.onSignalChange({
                    cliPath: (e.target as HTMLInputElement).value,
                  })}
                placeholder="signal-cli"
              />
            </label>
            <label class="field">
              <span>Auto start</span>
              <select
                .value=${props.signalForm.autoStart ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSignalChange({
                    autoStart: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Receive mode</span>
              <select
                .value=${props.signalForm.receiveMode}
                @change=${(e: Event) =>
                  props.onSignalChange({
                    receiveMode: (e.target as HTMLSelectElement).value as
                      | "on-start"
                      | "manual"
                      | "",
                  })}
              >
                <option value="">Default</option>
                <option value="on-start">on-start</option>
                <option value="manual">manual</option>
              </select>
            </label>
            <label class="field">
              <span>Ignore attachments</span>
              <select
                .value=${props.signalForm.ignoreAttachments ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSignalChange({
                    ignoreAttachments:
                      (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Ignore stories</span>
              <select
                .value=${props.signalForm.ignoreStories ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSignalChange({
                    ignoreStories: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Send read receipts</span>
              <select
                .value=${props.signalForm.sendReadReceipts ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onSignalChange({
                    sendReadReceipts:
                      (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Allow from</span>
              <input
                .value=${props.signalForm.allowFrom}
                @input=${(e: Event) =>
                  props.onSignalChange({
                    allowFrom: (e.target as HTMLInputElement).value,
                  })}
                placeholder="12345, +1555"
              />
            </label>
            <label class="field">
              <span>Media max MB</span>
              <input
                .value=${props.signalForm.mediaMaxMb}
                @input=${(e: Event) =>
                  props.onSignalChange({
                    mediaMaxMb: (e.target as HTMLInputElement).value,
                  })}
                placeholder="8"
              />
            </label>
          </div>

          ${props.signalStatus
            ? html`<div class="callout" style="margin-top: 12px;">
                ${props.signalStatus}
              </div>`
            : nothing}

          <div class="row" style="margin-top: 14px;">
            <button
              class="btn primary"
              ?disabled=${props.signalSaving}
              @click=${() => props.onSignalSave()}
            >
              ${props.signalSaving ? "Saving…" : "Save"}
            </button>
            <button class="btn" @click=${() => props.onRefresh(true)}>
              Probe
            </button>
          </div>
        </div>
      `;
    }
    case "imessage": {
      const imessage = data.imessage;
      return html`
        <div class="card">
          <div class="card-title">iMessage</div>
          <div class="card-sub">imsg CLI and database availability.</div>

          <div class="status-list" style="margin-top: 16px;">
            <div>
              <span class="label">Configured</span>
              <span>${imessage?.configured ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">Running</span>
              <span>${imessage?.running ? "Yes" : "No"}</span>
            </div>
            <div>
              <span class="label">CLI</span>
              <span>${imessage?.cliPath ?? "n/a"}</span>
            </div>
            <div>
              <span class="label">DB</span>
              <span>${imessage?.dbPath ?? "n/a"}</span>
            </div>
            <div>
              <span class="label">Last start</span>
              <span>
                ${imessage?.lastStartAt ? formatAgo(imessage.lastStartAt) : "n/a"}
              </span>
            </div>
            <div>
              <span class="label">Last probe</span>
              <span>
                ${imessage?.lastProbeAt ? formatAgo(imessage.lastProbeAt) : "n/a"}
              </span>
            </div>
          </div>

          ${imessage?.lastError
            ? html`<div class="callout danger" style="margin-top: 12px;">
                ${imessage.lastError}
              </div>`
            : nothing}

          ${imessage?.probe && !imessage.probe.ok
            ? html`<div class="callout" style="margin-top: 12px;">
                Probe failed · ${imessage.probe.error ?? "unknown error"}
              </div>`
            : nothing}

          <div class="form-grid" style="margin-top: 16px;">
            <label class="field">
              <span>Enabled</span>
              <select
                .value=${props.imessageForm.enabled ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onIMessageChange({
                    enabled: (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>CLI path</span>
              <input
                .value=${props.imessageForm.cliPath}
                @input=${(e: Event) =>
                  props.onIMessageChange({
                    cliPath: (e.target as HTMLInputElement).value,
                  })}
                placeholder="imsg"
              />
            </label>
            <label class="field">
              <span>DB path</span>
              <input
                .value=${props.imessageForm.dbPath}
                @input=${(e: Event) =>
                  props.onIMessageChange({
                    dbPath: (e.target as HTMLInputElement).value,
                  })}
                placeholder="~/Library/Messages/chat.db"
              />
            </label>
            <label class="field">
              <span>Service</span>
              <select
                .value=${props.imessageForm.service}
                @change=${(e: Event) =>
                  props.onIMessageChange({
                    service: (e.target as HTMLSelectElement).value as
                      | "auto"
                      | "imessage"
                      | "sms",
                  })}
              >
                <option value="auto">Auto</option>
                <option value="imessage">iMessage</option>
                <option value="sms">SMS</option>
              </select>
            </label>
            <label class="field">
              <span>Region</span>
              <input
                .value=${props.imessageForm.region}
                @input=${(e: Event) =>
                  props.onIMessageChange({
                    region: (e.target as HTMLInputElement).value,
                  })}
                placeholder="US"
              />
            </label>
            <label class="field">
              <span>Allow from</span>
              <input
                .value=${props.imessageForm.allowFrom}
                @input=${(e: Event) =>
                  props.onIMessageChange({
                    allowFrom: (e.target as HTMLInputElement).value,
                  })}
                placeholder="chat_id:101, +1555"
              />
            </label>
            <label class="field">
              <span>Include attachments</span>
              <select
                .value=${props.imessageForm.includeAttachments ? "yes" : "no"}
                @change=${(e: Event) =>
                  props.onIMessageChange({
                    includeAttachments:
                      (e.target as HTMLSelectElement).value === "yes",
                  })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label class="field">
              <span>Media max MB</span>
              <input
                .value=${props.imessageForm.mediaMaxMb}
                @input=${(e: Event) =>
                  props.onIMessageChange({
                    mediaMaxMb: (e.target as HTMLInputElement).value,
                  })}
                placeholder="16"
              />
            </label>
          </div>

          ${props.imessageStatus
            ? html`<div class="callout" style="margin-top: 12px;">
                ${props.imessageStatus}
              </div>`
            : nothing}

          <div class="row" style="margin-top: 14px;">
            <button
              class="btn primary"
              ?disabled=${props.imessageSaving}
              @click=${() => props.onIMessageSave()}
            >
              ${props.imessageSaving ? "Saving…" : "Save"}
            </button>
            <button class="btn" @click=${() => props.onRefresh(true)}>
              Probe
            </button>
          </div>
        </div>
      `;
    }
    default:
      return nothing;
  }
}
