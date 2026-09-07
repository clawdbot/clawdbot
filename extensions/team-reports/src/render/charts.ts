import { escapeHtml } from "./shared.js";

export function sparklineSvg(values: number[], label: string, large = false): string {
  if (values.length < 2) {
    return "";
  }
  const width = large ? 600 : 120;
  const height = large ? 48 : 28;
  const minimum = Math.min(...values);
  const span = Math.max(...values) - minimum || 1;
  const y = (value: number) =>
    Number((height - 3 - ((value - minimum) / span) * (height - 6)).toFixed(1));
  const path = values
    .map(
      (value, index) =>
        `${index ? `V${y(value)}` : `M0 ${y(value)}`} H${Number((((index + 1) * width) / values.length).toFixed(1))}`,
    )
    .join(" ");
  const endpoint = Math.min(Math.max(y(values.at(-1) ?? 0) - 2, 0), height - 4);
  return `<svg class="oc-sparkline"${large ? ' data-size="lg"' : ""} viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(label)}"><path class="oc-sparkline-line" d="${path}"/><rect class="oc-sparkline-endpoint" x="${width - 3}" y="${endpoint}" width="3" height="4"/></svg>`;
}

export function deltaMarkup(
  current: number,
  previous: number | undefined,
  label: string,
  badUp = false,
): string {
  if (previous === undefined) {
    return "";
  }
  const change = current - previous;
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const arrow = change > 0 ? "&#9650;" : change < 0 ? "&#9660;" : "&#8212;";
  const body =
    previous === 0
      ? change === 0
        ? "no change"
        : `+${change}`
      : `${change > 0 ? "+" : ""}${Math.round((change / previous) * 100)}%`;
  const tone = badUp && change !== 0 ? ` data-tone="${change > 0 ? "negative" : "positive"}"` : "";
  return `<span class="oc-delta" data-direction="${direction}"${tone}><span class="oc-delta-arrow" aria-hidden="true">${arrow}</span>${body} vs ${escapeHtml(label)}</span>`;
}

export function splitMarkup(items: { label: string; value: number; tone: string }[]): string {
  const shown = items.filter((item) => item.value > 0);
  const total = shown.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    return "";
  }
  let x = 0;
  const rects = shown
    .map((item) => {
      const width = (item.value / total) * 100;
      const rect = `<rect class="oc-split-segment${item.tone ? ` oc-split-${escapeHtml(item.tone)}` : ""}" x="${x.toFixed(2)}" y="0" width="${width.toFixed(2)}" height="8"/>`;
      x += width;
      return rect;
    })
    .join("");
  const label = shown
    .map((item) => `${item.label} ${Math.round((item.value / total) * 100)}%`)
    .join(", ");
  return `<svg class="oc-split" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(`Composition: ${label}`)}">${rects}</svg><ul class="oc-split-legend">${shown.map((item) => `<li><span class="oc-split-key${item.tone ? ` oc-split-${escapeHtml(item.tone)}` : ""}" aria-hidden="true"></span>${escapeHtml(item.label)} ${Math.round((item.value / total) * 100)}%</li>`).join("")}</ul>`;
}
