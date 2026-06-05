// Control UI view renders channels.imessage screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { IMessageStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderIMessageCard(params: {
  props: ChannelsProps;
  imessage?: IMessageStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, imessage, accountCountLabel } = params;
  const configured = resolveChannelConfigured("imessage", props);

  return renderSingleAccountChannelCard({
    title: "iMessage",
    subtitle: "macOS bridge status and channel configuration.",
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      { label: t("common.running"), value: imessage?.running ? t("common.yes") : t("common.no") },
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
    secondaryCallout: imessage?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${imessage.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
          ${imessage.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "imessage", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}
