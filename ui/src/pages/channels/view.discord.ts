// Channels page renders Discord status.
import { html, nothing } from "lit";
import type { DiscordStatus } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;
  const configured = resolveChannelConfigured("discord", props);

  return renderSingleAccountChannelCard({
    title: t("channels.discord.title"),
    subtitle: t("channels.discord.subtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      { label: t("common.running"), value: discord?.running ? t("common.yes") : t("common.no") },
      {
        label: t("common.lastStart"),
        value: discord?.lastStartAt ? formatRelativeTimestamp(discord.lastStartAt) : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: discord?.lastProbeAt ? formatRelativeTimestamp(discord.lastProbeAt) : t("common.na"),
      },
    ],
    lastError: discord?.lastError,
    secondaryCallout: discord?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${discord.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
          ${discord.probe.status ?? ""} ${discord.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "discord", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}
