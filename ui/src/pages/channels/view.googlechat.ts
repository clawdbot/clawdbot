// Channels page renders Google Chat status.
import { html, nothing } from "lit";
import type { GoogleChatStatus } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import {
  boolStatusKind,
  formatNullableBoolean,
  renderChannelProbeRow,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

export function renderGoogleChatCard(params: {
  props: ChannelsProps;
  googleChat?: GoogleChatStatus | null;
  accountCount?: number;
}) {
  const { props, googleChat, accountCount } = params;
  const configured = resolveChannelConfigured("googlechat", props);

  return renderSingleAccountChannelCard({
    title: t("channels.googleChat.title"),
    subtitle: t("channels.googleChat.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.running"),
        value: googleChat
          ? googleChat.running
            ? t("common.yes")
            : t("common.no")
          : t("common.na"),
        kind: boolStatusKind(googleChat?.running),
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
    secondaryCallout: googleChat?.probe ? renderChannelProbeRow(googleChat.probe) : nothing,
    configSection: renderChannelConfigSection({ channelId: "googlechat", props }),
    footer: html`<button class="btn" @click=${() => props.onRefresh(true)}>
      ${t("common.probe")}
    </button>`,
  });
}
