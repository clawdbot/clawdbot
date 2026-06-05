// Control UI view renders channelsiscord screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { DiscordStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./channels.shared.ts";
import type { ChannelsProps } from "./channels.types.ts";

export function renderDiscordCard(params: {
  props: ChannelsProps;
  discord?: DiscordStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, discord, accountCountLabel } = params;
  const configured = resolveChannelConfigured("discord", props);

  return renderSingleAccountChannelCard({
    title: "Discord",
    subtitle: "Bot status and channel configuration.",
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
