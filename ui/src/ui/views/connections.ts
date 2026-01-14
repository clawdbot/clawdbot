import { html, nothing } from "lit";

import { formatAgo } from "../format";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  DiscordStatus,
  IMessageStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../types";
import type {
  DiscordForm,
  IMessageForm,
  SlackForm,
  SignalForm,
  TelegramForm,
} from "../ui-types";
import type {
  ChannelKey,
  ConnectionsChannelData,
  ConnectionsProps,
} from "./connections.types";
import { channelEnabled, formatDuration, renderChannelAccountCount } from "./connections.shared";
import { discordActionOptions, slackActionOptions } from "./connections.action-options";
import { renderTelegramCard } from "./connections.telegram";
import { renderWhatsAppCard } from "./connections.whatsapp";

export function renderConnections(props: ConnectionsProps) {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  const whatsapp = (channels?.whatsapp ?? undefined) as
    | WhatsAppStatus
    | undefined;
  const telegram = (channels?.telegram ?? undefined) as
    | TelegramStatus
    | undefined;
  const discord = (channels?.discord ?? null) as DiscordStatus | null;
  const slack = (channels?.slack ?? null) as SlackStatus | null;
  const signal = (channels?.signal ?? null) as SignalStatus | null;
  const imessage = (channels?.imessage ?? null) as IMessageStatus | null;
  const channelOrder: ChannelKey[] = [
    "whatsapp",
    "telegram",
    "discord",
    "slack",
    "signal",
    "imessage",
  ];
  const orderedChannels = channelOrder
    .map((key, index) => ({
      key,
      enabled: channelEnabled(key, props),
      order: index,
    }))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.order - b.order;
    });

  return html`
    <section class="grid grid-cols-2">
      ${orderedChannels.map((channel) =>
        renderChannel(channel.key, props, {
          whatsapp,
          telegram,
          discord,
          slack,
          signal,
          imessage,
          channelAccounts: props.snapshot?.channelAccounts ?? null,
        }),
      )}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Connection health</div>
          <div class="card-sub">Channel status snapshots from the gateway.</div>
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

function renderChannel(
  key: ChannelKey,
  props: ConnectionsProps,
  data: ConnectionsChannelData,
) {
  const accountCountLabel = renderChannelAccountCount(
    key,
    data.channelAccounts,
  );
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        accountCountLabel,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        accountCountLabel,
      });
    case "discord": {
      const discord = data.discord;
      const botName = discord?.probe?.bot?.username;
      return html`
        <div class="card">
          <div class="card-title">Discord</div>
          <div class="card-sub">Bot connection and probe status.</div>
          ${accountCountLabel}

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
          ${accountCountLabel}

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
          ${accountCountLabel}

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
          ${accountCountLabel}

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
