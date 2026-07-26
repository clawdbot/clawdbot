// Channels page renders Signal status.
import { html, nothing } from "lit";
import type { SignalStatus } from "../../api/types.ts";
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

export function renderSignalCard(params: {
  props: ChannelsProps;
  signal?: SignalStatus | null;
  accountCount?: number;
}) {
  const { props, signal, accountCount } = params;
  const configured = resolveChannelConfigured("signal", props);

  return renderSingleAccountChannelCard({
    title: t("channels.signal.title"),
    subtitle: t("channels.signal.subtitle"),
    accountCount,
    statusRows: [
      {
        label: t("common.configured"),
        value: formatNullableBoolean(configured),
        kind: boolStatusKind(configured),
      },
      {
        label: t("common.running"),
        value: signal?.running ? t("common.yes") : t("common.no"),
        kind: boolStatusKind(signal?.running),
      },
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
    secondaryCallout: signal?.probe ? renderChannelProbeRow(signal.probe) : nothing,
    configSection: renderChannelConfigSection({ channelId: "signal", props }),
    footer: html`<button class="btn" @click=${() => props.onRefresh(true)}>
      ${t("common.probe")}
    </button>`,
  });
}
