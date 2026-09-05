import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import { html, nothing, type TemplateResult } from "lit";
import { renderCapacityMeter } from "../../components/capacity-meter.ts";
import { t } from "../../i18n/index.ts";
import { formatByteSize, formatTimeAgo } from "../../lib/format.ts";

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

function resourceMeter(
  resource: "load" | "memory" | "disk",
  percent: number,
  label: string,
  title: string,
  age: string | undefined,
  warn = 80,
  danger = 90,
) {
  const tone =
    age !== undefined ? "stale" : percent < warn ? "ok" : percent < danger ? "warn" : "danger";
  const displayLabel = age === undefined ? label : `${label} · ${age}`;
  const displayTitle =
    age === undefined ? title : `${title} · ${t("devices.inventory.lastKnown", { time: age })}`;
  return html`<span class="device-resource device-resource--${resource}" title=${displayTitle}>
    <span class="device-resource__label">${displayLabel}</span>
    ${renderCapacityMeter({
      mode: "continuous",
      percent: Math.min(100, Math.max(0, percent)),
      tone,
      label: displayTitle,
    })}
  </span>`;
}

export function renderHostStats(stats: HostResources | null | undefined, lastKnownAtMs?: number) {
  if (!stats) {
    return nothing;
  }
  const age =
    lastKnownAtMs === undefined
      ? undefined
      : formatTimeAgo(Math.max(0, Date.now() - lastKnownAtMs));
  const meters: TemplateResult[] = [];
  if (stats.loadAverage && stats.cpuCount > 0) {
    const title = t("devices.inventory.loadTitle", {
      averages: stats.loadAverage.map((value) => value.toFixed(2)).join(" / "),
      cores: String(stats.cpuCount),
    });
    meters.push(
      resourceMeter(
        "load",
        (stats.loadAverage[0] / stats.cpuCount) * 100,
        t("devices.inventory.loadLabel", { load: stats.loadAverage[0].toFixed(1) }),
        title,
        age,
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
        "memory",
        (usedBytes / stats.memoryTotalBytes) * 100,
        `${compactUsed} / ${total}`,
        t("devices.inventory.memoryTitle", { used, total }),
        age,
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
        "disk",
        (1 - stats.diskAvailableBytes / stats.diskTotalBytes) * 100,
        t("devices.inventory.diskLabel", { available }),
        t("devices.inventory.diskTitle", { available, total }),
        age,
      ),
    );
  }
  return meters.length ? html`<div class="device-resources">${meters}</div>` : nothing;
}
