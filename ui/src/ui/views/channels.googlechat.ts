// Control UI view renders channels.googlechat screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { GoogleChatStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, googleChat, accountCountLabel } = params;
  const configured = resolveChannelConfigured("googlechat", props);

  return renderSingleAccountChannelCard({
    title: "Google Chat",
    subtitle: "Chat API webhook status and channel configuration.",
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      {
        label: t("common.running"),
        value: googleChat
          ? googleChat.running
            ? t("common.yes")
            : t("common.no")
          : t("common.na"),
      },
      { label: t("common.credential"), value: googleChat?.credentialSource ?? t("common.na") },
      {
        label: t("common.audience"),
        value: googleChat?.audienceType
          ? `${googleChat.audienceType}${googleChat.audience ? ` · ${googleChat.audience}` : ""}`
          : t("common.na"),
      },
      {
        label: t("common.lastStart"),
        value: googleChat?.lastStartAt
          ? formatRelativeTimestamp(googleChat.lastStartAt)
          : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: googleChat?.lastProbeAt
          ? formatRelativeTimestamp(googleChat.lastProbeAt)
          : t("common.na"),
      },
    ],
    lastError: googleChat?.lastError,
    secondaryCallout: googleChat?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${googleChat.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
          ${googleChat.probe.status ?? ""} ${googleChat.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "googlechat", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}
