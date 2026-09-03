import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import { html, nothing, type TemplateResult } from "lit";
import { renderCapacityMeter } from "../../components/capacity-meter.ts";
import { t } from "../../i18n/index.ts";
import { formatByteSize } from "../../lib/format.ts";

type HostResources = Pick<
  SystemInfoResult,
  | "cpuCount"
  | "loadAverage"
  | "memoryTotalBytes"
  | "memoryFreeBytes"
  | "diskTotalBytes"
  | "diskAvailableBytes"
>;

function formatResourceBytes(bytes: number): string {
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "tera" || value < 10 ? 1 : 0),
  });
}

function resourceMeter(percent: number, label: string, title: string, warn = 80, danger = 90) {
  const tone = percent < warn ? "ok" : percent < danger ? "warn" : "danger";
  return html`<span class="device-resource" title=${title}>
    <span class="device-resource__label">${label}</span>
    ${renderCapacityMeter({
      mode: "continuous",
      percent: Math.min(100, Math.max(0, percent)),
      tone,
      label: title,
    })}
  </span>`;
}

export function renderHostStats(stats: HostResources | null | undefined) {
  if (!stats) {
    return nothing;
  }
  const meters: TemplateResult[] = [];
  if (stats.loadAverage && stats.cpuCount > 0) {
    const title = t("devices.inventory.loadTitle", {
      averages: stats.loadAverage.map((value) => value.toFixed(2)).join(" / "),
      cores: String(stats.cpuCount),
    });
    meters.push(
      resourceMeter(
        (stats.loadAverage[0] / stats.cpuCount) * 100,
        t("devices.inventory.loadLabel", { load: stats.loadAverage[0].toFixed(1) }),
        title,
        70,
        100,
      ),
    );
  }
  if (stats.memoryTotalBytes > 0 && stats.memoryFreeBytes >= 0) {
    const usedBytes = stats.memoryTotalBytes - stats.memoryFreeBytes;
    const used = formatResourceBytes(usedBytes);
    const total = formatResourceBytes(stats.memoryTotalBytes);
    const unit = total.slice(total.lastIndexOf(" "));
    const compactUsed = used.endsWith(unit) ? used.slice(0, -unit.length) : used;
    meters.push(
      resourceMeter(
        (usedBytes / stats.memoryTotalBytes) * 100,
        `${compactUsed} / ${total}`,
        t("devices.inventory.memoryTitle", { used, total }),
      ),
    );
  }
  if (
    stats.diskTotalBytes != null &&
    stats.diskTotalBytes > 0 &&
    stats.diskAvailableBytes != null
  ) {
    const available = formatResourceBytes(stats.diskAvailableBytes);
    const total = formatResourceBytes(stats.diskTotalBytes);
    meters.push(
      resourceMeter(
        (1 - stats.diskAvailableBytes / stats.diskTotalBytes) * 100,
        t("devices.inventory.diskLabel", { available }),
        t("devices.inventory.diskTitle", { available, total }),
      ),
    );
  }
  return meters.length ? html`<div class="device-resources">${meters}</div>` : nothing;
}
