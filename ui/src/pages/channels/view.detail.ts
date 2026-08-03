// Channel detail overlay: full status + advanced schema config form for one
// channel, reusing the per-channel settings-language renderers.
import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import type { NostrProfile } from "../../api/types.ts";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import "../../components/modal-dialog.ts";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { channelDocsUrl, renderChannelArt } from "./hub-meta.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import { renderNostrCard } from "./view.nostr.ts";
import { renderChannelPairingDetail } from "./view.pairing.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelAccountRow,
  renderChannelActionRow,
  renderChannelErrorRow,
  renderChannelFacts,
  renderChannelProbeRow,
  resolveChannelAccountCount,
  resolveChannelDisplayState,
} from "./view.shared.ts";
import type { ChannelKey, ChannelsChannelData, ChannelsProps } from "./view.types.ts";
import { renderWhatsAppCard } from "./view.whatsapp.ts";

const STANDARD_CHANNEL_LOCALE_KEYS = {
  discord: "discord",
  googlechat: "googleChat",
  imessage: "imessage",
  signal: "signal",
  slack: "slack",
  telegram: "telegram",
} as const;

type StandardChannelKey = keyof typeof STANDARD_CHANNEL_LOCALE_KEYS;

function isStandardChannel(key: ChannelKey): key is StandardChannelKey {
  return Object.hasOwn(STANDARD_CHANNEL_LOCALE_KEYS, key);
}

function renderChannelStatusBody(
  key: ChannelKey,
  props: ChannelsProps,
  data: ChannelsChannelData,
  accountCount: number | undefined,
) {
  const standardKey = isStandardChannel(key) ? key : null;
  const localeKey = standardKey ? STANDARD_CHANNEL_LOCALE_KEYS[standardKey] : null;
  const status = standardKey ? data[standardKey] : undefined;
  const displayState = resolveChannelDisplayState(key, props);
  const configured = displayState.configured;
  const accounts = resolveChannelAccounts(data.channelAccounts, key);
  const showAccounts =
    standardKey === "telegram" ? accounts.length > 1 : !standardKey && accounts.length > 0;
  const extraRows =
    standardKey === "googlechat"
      ? [
          {
            label: t("common.credential"),
            value: data.googlechat?.credentialSource ?? t("common.na"),
          },
          {
            label: t("common.audience"),
            value: data.googlechat?.audienceType
              ? `${data.googlechat.audienceType}${data.googlechat.audience ? ` · ${data.googlechat.audience}` : ""}`
              : t("common.na"),
          },
        ]
      : standardKey === "signal"
        ? [{ label: t("common.baseUrl"), value: data.signal?.baseUrl ?? t("common.na") }]
        : standardKey === "telegram"
          ? [{ label: t("common.mode"), value: data.telegram?.mode ?? t("common.na") }]
          : [];
  const statusRows = [
    {
      label: t("common.configured"),
      value: formatNullableBoolean(configured),
      kind: boolStatusKind(configured),
    },
    {
      label: t("common.running"),
      value: !standardKey
        ? formatNullableBoolean(displayState.running)
        : standardKey === "googlechat" && !status
          ? t("common.na")
          : formatNullableBoolean(status?.running ?? false),
      kind: boolStatusKind(standardKey ? status?.running : displayState.running),
    },
    ...(standardKey
      ? [
          ...extraRows,
          ...(["lastStartAt", "lastProbeAt"] as const).map((field) => ({
            label: t(field === "lastStartAt" ? "common.lastStart" : "common.lastProbe"),
            value: status?.[field] ? formatRelativeTimestamp(status[field]) : t("common.na"),
          })),
        ]
      : [
          {
            label: t("common.connected"),
            value: formatNullableBoolean(displayState.connected),
            kind: boolStatusKind(displayState.connected),
          },
        ]),
  ];
  const lastError = readStringField(
    asNullableRecord(standardKey ? status : displayState.status),
    "lastError",
  );

  return renderSettingsSection(
    {
      title: localeKey
        ? t(`channels.${localeKey}.title`)
        : (readStringField(props.snapshot?.channelLabels, key) ?? key),
      description: localeKey ? t(`channels.${localeKey}.subtitle`) : t("channels.generic.subtitle"),
      ...(accountCount !== undefined ? { count: accountCount } : {}),
    },
    html`
      ${showAccounts
        ? accounts.map((account) => {
            const username =
              standardKey === "telegram"
                ? readStringField(
                    asNullableRecord(asNullableRecord(account.probe)?.bot),
                    "username",
                  )
                : undefined;
            return renderChannelAccountRow({
              title: username ? `@${username}` : account.name || account.accountId,
              accountId: account.accountId,
              ...(standardKey === "telegram"
                ? {
                    facts: [
                      `${t("common.configured")}: ${account.configured ? t("common.yes") : t("common.no")}`,
                    ],
                  }
                : {}),
              status: {
                kind: boolStatusKind(
                  standardKey === "telegram"
                    ? account.running
                    : (account.running ?? account.configured),
                ),
                label: account.running
                  ? t("common.running")
                  : !standardKey && account.configured
                    ? t("common.configured")
                    : t("common.no"),
              },
              lastInboundAt: account.lastInboundAt,
              lastError: account.lastError,
            });
          })
        : renderChannelFacts(statusRows)}
      ${lastError ? renderChannelErrorRow(lastError) : nothing}
      ${standardKey && status?.probe ? renderChannelProbeRow(status.probe) : nothing}
      ${renderChannelConfigSection({ channelId: key, props })}
      ${standardKey
        ? renderChannelActionRow(html`<button class="btn" @click=${() => props.onRefresh(true)}>
            ${t("common.probe")}
          </button>`)
        : nothing}
    `,
  );
}

function renderChannelBody(key: ChannelKey, props: ChannelsProps, data: ChannelsChannelData) {
  const accountCount = resolveChannelAccountCount(key, data.channelAccounts);
  switch (key) {
    case "whatsapp":
      return renderWhatsAppCard({
        props,
        whatsapp: data.whatsapp,
        accountCount,
      });
    case "nostr": {
      const nostrAccounts = resolveChannelAccounts(data.channelAccounts, "nostr");
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
      return renderChannelStatusBody(key, props, data, accountCount);
  }
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
            <a
              class="btn btn--sm"
              href=${channelDocsUrl(params.channelId)}
              target="_blank"
              rel="noreferrer"
            >
              ${t("common.docs")}
            </a>
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
