// Channel detail overlay: full status + advanced schema config form for one
// channel, reusing the per-channel settings-language renderers.
import { html, nothing, type TemplateResult } from "lit";
import type { ChannelAccountSnapshot, NostrProfile } from "../../api/types.ts";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import { renderChannelArt } from "./hub-meta.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import { renderDiscordCard } from "./view.discord.ts";
import { renderGoogleChatCard } from "./view.googlechat.ts";
import { renderIMessageCard } from "./view.imessage.ts";
import { renderNostrCard } from "./view.nostr.ts";
import { renderChannelPairingDetail } from "./view.pairing.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelAccountRow,
  renderChannelErrorRow,
  renderChannelFacts,
  resolveChannelAccountCount,
  resolveChannelDisplayState,
} from "./view.shared.ts";
import { renderSignalCard } from "./view.signal.ts";
import { renderSlackCard } from "./view.slack.ts";
import { renderTelegramCard } from "./view.telegram.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./view.types.ts";
import { renderWhatsAppCard } from "./view.whatsapp.ts";

function renderChannelBody(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  const accountCount = resolveChannelAccountCount(key, data.channelAccounts);
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        accountCount,
      });
    case "telegram":
      return renderTelegramCard({
        props,
        telegram: data.telegram,
        telegramAccounts: data.channelAccounts?.telegram ?? [],
        accountCount,
      });
    case "discord":
      return renderDiscordCard({
        props,
        discord: data.discord,
        accountCount,
      });
    case "googlechat":
      return renderGoogleChatCard({
        props,
        googleChat: data.googlechat,
        accountCount,
      });
    case "slack":
      return renderSlackCard({
        props,
        slack: data.slack,
        accountCount,
      });
    case "signal":
      return renderSignalCard({
        props,
        signal: data.signal,
        accountCount,
      });
    case "imessage":
      return renderIMessageCard({
        props,
        imessage: data.imessage,
        accountCount,
      });
    case "nostr": {
      const nostrAccounts = data.channelAccounts?.nostr ?? [];
      const primaryAccount = nostrAccounts[0];
      const accountId = primaryAccount?.accountId ?? "default";
      const profile =
        (primaryAccount as { profile?: NostrProfile | null } | undefined)?.profile ?? null;
      const showForm =
        props.nostrProfileAccountId === accountId ? props.nostrProfileFormState : null;
      const profileFormCallbacks = showForm
        ? {
            onFieldChange: props.onNostrProfileFieldChange,
            onSave: props.onNostrProfileSave,
            onImport: props.onNostrProfileImport,
            onCancel: props.onNostrProfileCancel,
            onToggleAdvanced: props.onNostrProfileToggleAdvanced,
          }
        : null;
      return renderNostrCard({
        props,
        nostr: data.nostr,
        nostrAccounts,
        accountCount,
        profileFormState: showForm,
        profileFormCallbacks,
        onEditProfile: () => props.onNostrProfileEdit(accountId, profile),
      });
    }
    default:
      return renderGenericChannelBody(key, props, data.channelAccounts ?? {});
  }
}

function renderGenericChannelBody(
  key: ChannelKey,
  props: ChannelsProps,
  channelAccounts: Record<string, ChannelAccountSnapshot[]>,
) {
  const label = props.snapshot?.channelLabels?.[key] ?? key;
  const displayState = resolveChannelDisplayState(key, props);
  const lastError =
    typeof displayState.status?.lastError === "string" ? displayState.status.lastError : undefined;
  const accounts = channelAccounts[key] ?? [];
  const accountCount = resolveChannelAccountCount(key, channelAccounts);

  return renderSettingsSection(
    {
      title: label,
      description: t("channels.generic.subtitle"),
      ...(accountCount !== undefined ? { count: accountCount } : {}),
    },
    html`
      ${accounts.length > 0
        ? accounts.map((account) =>
            renderChannelAccountRow({
              title: account.name || account.accountId,
              accountId: account.accountId,
              status: {
                kind: boolStatusKind(account.running ?? account.configured),
                label: account.running
                  ? t("common.running")
                  : account.configured
                    ? t("common.configured")
                    : t("common.no"),
              },
              lastInboundAt: account.lastInboundAt,
              lastError: account.lastError,
            }),
          )
        : renderChannelFacts([
            {
              label: t("common.configured"),
              value: formatNullableBoolean(displayState.configured),
              kind: boolStatusKind(displayState.configured),
            },
            {
              label: t("common.running"),
              value: formatNullableBoolean(displayState.running),
              kind: boolStatusKind(displayState.running),
            },
            {
              label: t("common.connected"),
              value: formatNullableBoolean(displayState.connected),
              kind: boolStatusKind(displayState.connected),
            },
          ])}
      ${lastError ? renderChannelErrorRow(lastError) : nothing}
      ${renderChannelConfigSection({ channelId: key, props })}
    `,
  );
}

export function renderChannelDetail(params: {
  channelId: string;
  label: string;
  props: ChannelsProps;
  data: ChannelsChannelData;
  onClose: () => void;
  onSetup: () => void;
}): TemplateResult {
  const body = renderChannelBody(params.channelId, params.props, params.data);
  return html`
    <openclaw-modal-dialog label=${params.label} @modal-cancel=${() => params.onClose()}>
      <div class="channels-detail">
        <div class="channels-detail__header">
          ${renderChannelArt(params.channelId, params.label, "cover")}
          <div class="channels-detail__header-actions">
            <button type="button" class="btn btn--sm" @click=${() => params.onSetup()}>
              ${t("channels.hub.runSetup")}
            </button>
            <button
              type="button"
              class="btn channels-detail__close"
              aria-label=${t("common.close")}
              @click=${() => params.onClose()}
            >
              ✕
            </button>
          </div>
        </div>
        <div class="channels-detail__body">
          ${params.props.setupBlockedByDirtyConfig && params.props.configFormDirty
            ? html`<div class="callout warn">${t("channels.hub.saveBeforeSetup")}</div>`
            : nothing}
          ${renderChannelPairingDetail(params.channelId, params.props)} ${body}
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
