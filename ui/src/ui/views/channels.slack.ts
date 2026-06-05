// Control UI view renders channels.slack screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { SlackStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderSlackCard(params: {
  props: ChannelsProps;
  slack?: SlackStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, slack, accountCountLabel } = params;
  const configured = resolveChannelConfigured("slack", props);

  return renderSingleAccountChannelCard({
    title: "Slack",
    subtitle: "Socket mode status and channel configuration.",
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      { label: t("common.running"), value: slack?.running ? t("common.yes") : t("common.no") },
      {
        label: t("common.lastStart"),
        value: slack?.lastStartAt ? formatRelativeTimestamp(slack.lastStartAt) : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: slack?.lastProbeAt ? formatRelativeTimestamp(slack.lastProbeAt) : t("common.na"),
      },
    ],
    lastError: slack?.lastError,
    secondaryCallout: slack?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${slack.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
          ${slack.probe.status ?? ""} ${slack.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "slack", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}
