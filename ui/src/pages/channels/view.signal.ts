// Channels page renders Signal status.
import { html, nothing } from "lit";
import type { SignalStatus } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { renderChannelConfigSection } from "./view.config.ts";
import {
  formatNullableBoolean,
  renderSingleAccountChannelCard,
  resolveChannelConfigured,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCountLabel: unknown;
}) {
  const { props, signal, accountCountLabel } = params;
  const configured = resolveChannelConfigured("signal", props);

  return renderSingleAccountChannelCard({
    title: t("channels.signal.title"),
    subtitle: t("channels.signal.subtitle"),
    accountCountLabel,
    statusRows: [
      { label: t("common.configured"), value: formatNullableBoolean(configured) },
      { label: t("common.running"), value: signal?.running ? t("common.yes") : t("common.no") },
      { label: t("common.baseUrl"), value: signal?.baseUrl ?? t("common.na") },
      {
        label: t("common.lastStart"),
        value: signal?.lastStartAt ? formatRelativeTimestamp(signal.lastStartAt) : t("common.na"),
      },
      {
        label: t("common.lastProbe"),
        value: signal?.lastProbeAt ? formatRelativeTimestamp(signal.lastProbeAt) : t("common.na"),
      },
    ],
    lastError: signal?.lastError,
    secondaryCallout: signal?.probe
      ? html`<div class="callout" style="margin-top: 12px;">
          ${signal.probe.ok ? t("common.probeOk") : t("common.probeFailed")} ·
          ${signal.probe.status ?? ""} ${signal.probe.error ?? ""}
        </div>`
      : nothing,
    configSection: renderChannelConfigSection({ channelId: "signal", props }),
    footer: html`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${() => props.onRefresh(true)}>${t("common.probe")}</button>
    </div>`,
  });
}
