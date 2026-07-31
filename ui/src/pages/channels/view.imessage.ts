// Channels page renders iMessage status.
import { html, nothing } from "lit";
import type { IMessageStatus } from "../../api/types.ts";
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

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCount?: number;
}) {
  const { props, imessage, accountCount } = params;
  const configured = resolveChannelConfigured("imessage", props);

  return renderSingleAccountChannelCard({
    title: t("channels.imessage.title"),
    subtitle: t("channels.imessage.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.running"),
        value: imessage?.running ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(imessage?.running),
      },
      {
        label: t("common.lastStart"),
        value: imessage?.lastStartAt
          ? formatRelativeTimestamp(imessage.lastStartAt)
          : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: imessage?.lastProbeAt
          ? formatRelativeTimestamp(imessage.lastProbeAt)
          : t("common.na"),
      },
    ],
    lastError: imessage?.lastError,
    secondaryCallout: imessage?.probe ? renderChannelProbeRow(imessage.probe) : nothing,
    configSection: renderChannelConfigSection({ channelId: "imessage", props }),
    footer: html`<button class="btn" @click=${() => props.onRefresh(true)}>
      ${t("common.probe")}
    </button>`,
  });
}
