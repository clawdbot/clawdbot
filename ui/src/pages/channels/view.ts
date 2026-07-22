// Channels hub: connected-channel rows, add-a-channel gallery, setup wizard,
// and a per-channel detail overlay with the full config form.
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import "../../styles/channels.css";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  ChannelUiMetaEntry,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { highlightJsonHtml } from "../../components/markdown.ts";
import "../../components/openclaw-mascot.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelArt } from "./hub-meta.ts";
import { renderChannelDetail } from "./view.detail.ts";
import { renderChannelPairingPrompt, renderChannelPairingQueue } from "./view.pairing.ts";
import { channelEnabled, resolveChannelDisplayState } from "./view.shared.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./view.types.ts";
import { renderChannelWizard } from "./wizard-view.ts";

type ChannelCardState = "running" | "configured" | "attention";

export function renderChannels(props: ChannelsProps) {
  const channelOrder = resolveChannelOrder(props.snapshot);
  const connected = channelOrder.filter((key) => channelEnabled(key, props));
  const available = channelOrder.filter((key) => !channelEnabled(key, props));
  const showingStaleSnapshot = Boolean(props.loading && props.snapshot && props.lastSuccessAt);
  const partialWarnings = props.snapshot?.warnings?.filter((warning) => warning.trim()) ?? [];
  const data = buildChannelData(props);
  const selected = props.selectedChannel;

  return html`
    ${renderSettingsPage(html`
      ${showingStaleSnapshot
        ? html`<div class="callout info">${t("channels.refreshingStaleSnapshot")}</div>`
        : nothing}
      ${props.snapshot?.partial
        ? html`
            <div class="callout warn">
              ${t("channels.hub.partialSnapshot")}
              ${partialWarnings.length > 0 ? partialWarnings.slice(0, 3).join("; ") : ""}
            </div>
          `
        : nothing}
      ${props.lastError ? html`<div class="callout danger">${props.lastError}</div>` : nothing}
      ${props.setupBlockedByDirtyConfig && props.configFormDirty
        ? html`<div class="callout warn">${t("channels.hub.saveBeforeSetup")}</div>`
        : nothing}
      ${renderChannelPairingQueue(props)}
      ${renderSettingsSection(
        {
          title: t("channels.hub.connectedTitle"),
          ...(connected.length > 0 ? { count: connected.length } : {}),
          actions: html`
            <span class="settings-row__value">
              ${props.lastSuccessAt
                ? t("channels.hub.updatedAgo", {
                    ago: formatRelativeTimestamp(props.lastSuccessAt),
                  })
                : t("common.na")}
            </span>
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${props.loading}
              @click=${() => props.onRefresh(true)}
            >
              ${t("common.refresh")}
            </button>
          `,
        },
        connected.length === 0
          ? html`
              <div class="channels-empty">
                <!-- No configured transports is a true empty state, so Clawd rests here. -->
                <openclaw-mascot mood="sleepy" .size=${80}></openclaw-mascot>
                ${renderSettingsEmpty(t("channels.hub.noneConnected"))}
              </div>
            `
          : connected.map((key) => renderConnectedRow(key, props)),
      )}
      ${renderSettingsSection(
        {
          title: t("channels.hub.addTitle"),
          description: t("channels.hub.addSubtitle"),
        },
        html`
          ${available.map((key) => renderAvailableRow(key, props))} ${renderBrowseAllRow(props)}
        `,
      )}
      ${renderSettingsSection(
        {
          title: t("channels.health.title"),
          description: t("channels.health.subtitle"),
        },
        html`
          <div class="settings-row settings-row--stacked">
            <pre class="code-block">
${props.snapshot
                ? unsafeHTML(highlightJsonHtml(JSON.stringify(props.snapshot, null, 2)))
                : t("channels.health.noSnapshotYet")}</pre>
          </div>
        `,
      )}
    `)}
    ${selected
      ? renderChannelDetail({
          channelId: selected,
          label: resolveChannelLabel(props.snapshot, selected),
          props,
          data,
          onClose: () => props.onCloseDetail(),
          onSetup: () => props.onStartSetup(selected),
        })
      : nothing}
    ${renderChannelWizard({
      wizard: props.wizard,
      channelLabel: (channelId) => resolveChannelLabel(props.snapshot, channelId),
      multiselectValues: props.wizardMultiselect,
      onToggleMultiselect: props.onWizardToggleMultiselect,
      onAnswer: props.onWizardAnswer,
      onClose: props.onWizardClose,
      whatsappQrDataUrl: props.whatsappQrDataUrl,
      whatsappMessage: props.whatsappMessage,
      whatsappConnected: props.whatsappConnected,
      whatsappBusy: props.whatsappBusy,
      onWhatsAppStart: props.onWhatsAppStart,
      onWhatsAppWait: props.onWhatsAppWait,
    })}
    ${renderChannelPairingPrompt(props)}
  `;
}

function buildChannelData(props: ChannelsProps): ChannelsChannelData {
  const channels = props.snapshot?.channels as Record<string, unknown> | null;
  return {
    whatsapp: (channels?.whatsapp ?? undefined) as WhatsAppStatus | undefined,
    telegram: (channels?.telegram ?? undefined) as TelegramStatus | undefined,
    discord: (channels?.discord ?? null) as DiscordStatus | null,
    googlechat: (channels?.googlechat ?? null) as GoogleChatStatus | null,
    slack: (channels?.slack ?? null) as SlackStatus | null,
    signal: (channels?.signal ?? null) as SignalStatus | null,
    imessage: (channels?.imessage ?? null) as IMessageStatus | null,
    nostr: (channels?.nostr ?? null) as NostrStatus | null,
    channelAccounts: props.snapshot?.channelAccounts ?? null,
  };
}

function resolveChannelOrder(snapshot: ChannelsStatusSnapshot | null): ChannelKey[] {
  if (snapshot?.channelMeta?.length) {
    return snapshot.channelMeta.map((entry) => entry.id);
  }
  if (snapshot?.channelOrder?.length) {
    return snapshot.channelOrder;
  }
  return ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage", "nostr"];
}

function resolveChannelMetaMap(
  snapshot: ChannelsStatusSnapshot | null,
): Record<string, ChannelUiMetaEntry> {
  if (!snapshot?.channelMeta?.length) {
    return {};
  }
  return Object.fromEntries(snapshot.channelMeta.map((entry) => [entry.id, entry]));
}

function resolveChannelLabel(snapshot: ChannelsStatusSnapshot | null, key: string): string {
  const meta = resolveChannelMetaMap(snapshot)[key];
  return meta?.label ?? snapshot?.channelLabels?.[key] ?? key;
}

function resolveChannelDetailLabel(
  snapshot: ChannelsStatusSnapshot | null,
  key: string,
): string | null {
  const meta = resolveChannelMetaMap(snapshot)[key];
  const detail = meta?.detailLabel ?? snapshot?.channelDetailLabels?.[key] ?? null;
  return detail && detail !== resolveChannelLabel(snapshot, key) ? detail : null;
}

function resolveRowState(key: ChannelKey, props: ChannelsProps): ChannelCardState {
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" && displayState.status.lastError.trim()
      ? displayState.status.lastError
      : (props.snapshot?.channelAccounts?.[key] ?? []).find((account) => account.lastError)
          ?.lastError;
  if (lastError) {
    return "attention";
  }
  if (displayState.running === true || displayState.connected === true) {
    return "running";
  }
  return "configured";
}

function rowStatus(state: ChannelCardState) {
  switch (state) {
    case "running":
      return renderSettingsStatus({ kind: "ok", label: t("channels.hub.stateRunning") });
    case "configured":
      return renderSettingsStatus({ kind: "muted", label: t("channels.hub.stateConfigured") });
    case "attention":
      return renderSettingsStatus({ kind: "danger", label: t("channels.hub.stateAttention") });
    default:
      return state satisfies never;
  }
}

function lastActivityLine(key: ChannelKey, props: ChannelsProps): string | null {
  const accounts: ChannelAccountSnapshot[] = props.snapshot?.channelAccounts?.[key] ?? [];
  const lastInbound = accounts
    .map((account) => account.lastInboundAt ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  if (!lastInbound) {
    return null;
  }
  return t("channels.hub.lastMessageAgo", { ago: formatRelativeTimestamp(lastInbound) });
}

function renderConnectedRow(key: ChannelKey, props: ChannelsProps) {
  const label = resolveChannelLabel(props.snapshot, key);
  const description =
    lastActivityLine(key, props) ??
    resolveChannelDetailLabel(props.snapshot, key) ??
    t("channels.hub.openDetails");
  return html`
    <button
      type="button"
      class="settings-row settings-row--nav channels-item"
      @click=${() => props.onShowDetail(key)}
    >
      ${renderChannelArt(key, label, "tile")}
      <div class="settings-row__text">
        <span class="settings-row__title">${label}</span>
        <span class="settings-row__desc">${description}</span>
      </div>
      <div class="settings-row__control">
        ${rowStatus(resolveRowState(key, props))}
        <span class="settings-row__chevron">${icons.chevronRight}</span>
      </div>
    </button>
  `;
}

function renderAvailableRow(key: ChannelKey, props: ChannelsProps) {
  const label = resolveChannelLabel(props.snapshot, key);
  const description =
    resolveChannelDetailLabel(props.snapshot, key) ?? t("channels.hub.guidedSetup");
  return html`
    <div class="settings-row channels-item">
      <button
        type="button"
        class="channels-item__detail"
        title=${t("channels.hub.openDetails")}
        @click=${() => props.onShowDetail(key)}
      >
        ${renderChannelArt(key, label, "tile")}
        <span class="settings-row__text">
          <span class="settings-row__title">${label}</span>
          <span class="settings-row__desc">${description}</span>
        </span>
      </button>
      <div class="settings-row__control">
        <button type="button" class="btn btn--sm" @click=${() => props.onStartSetup(key)}>
          ${t("channels.hub.setUp")}
        </button>
      </div>
    </div>
  `;
}

function renderBrowseAllRow(props: ChannelsProps) {
  return html`
    <button
      type="button"
      class="settings-row settings-row--nav channels-item"
      @click=${() => props.onStartSetup(null)}
    >
      <span
        class="channels-tile channels-tile--fallback"
        style="--channels-art-a:#64748b;--channels-art-b:#1e293b"
        aria-hidden="true"
      >
        <span>+</span>
      </span>
      <div class="settings-row__text">
        <span class="settings-row__title">${t("channels.hub.browseAllTitle")}</span>
        <span class="settings-row__desc">${t("channels.hub.browseAllSubtitle")}</span>
      </div>
      <div class="settings-row__control">
        <span class="settings-row__chevron">${icons.chevronRight}</span>
      </div>
    </button>
  `;
}
