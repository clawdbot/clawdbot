import { html, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, toFiniteNumber, widgetProps } from "./types.ts";

type ChartType = "line" | "bar" | "area" | "sparkline" | "gauge";

type ChartDataResult = { ok: true; values: number[] } | { ok: false; reason: string };
type ChartModel =
  | { status: "empty" }
  | { status: "error"; reason: string }
  | {
      status: "ready";
      type: ChartType;
      values: number[];
      min: number;
      max: number;
      dataMin: number;
      dataMax: number;
    };

const CHART_TYPES = new Set<ChartType>(["line", "bar", "area", "sparkline", "gauge"]);
const MAX_CHART_POINTS = 500;
const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 40;
const PADDING = 2;

function greaterFiniteBound(value: number): number | undefined {
  if (value === Number.MAX_VALUE) {
    return undefined;
  }
  return value >= 0 ? Math.min(value * 2 || 1, Number.MAX_VALUE) : value / 2;
}

function lesserFiniteBound(value: number): number | undefined {
  if (value === -Number.MAX_VALUE) {
    return undefined;
  }
  return value <= 0 ? Math.max(value * 2 || -1, -Number.MAX_VALUE) : value / 2;
}

function pointValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return toFiniteNumber(value.y) ?? toFiniteNumber(value.value);
}

function normalizeChartData(value: unknown): ChartDataResult {
  const points = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.points)
      ? value.points
      : null;
  if (points === null) {
    return { ok: false, reason: "expected an array or an object with a points array" };
  }
  if (points.length > MAX_CHART_POINTS) {
    return { ok: false, reason: `chart data exceeds ${MAX_CHART_POINTS} points` };
  }
  const values: number[] = [];
  for (const point of points) {
    const numeric = pointValue(point);
    if (numeric === undefined) {
      return { ok: false, reason: "every chart point must contain a finite numeric value" };
    }
    values.push(numeric);
  }
  return { ok: true, values };
}

function mapChart(widget: WorkspaceWidget, value: unknown): ChartModel {
  const props = widgetProps(widget);
  const rawType = props.type === undefined ? "line" : props.type;
  if (typeof rawType !== "string" || !CHART_TYPES.has(rawType as ChartType)) {
    return { status: "error", reason: "unsupported chart type" };
  }
  const data = normalizeChartData(value);
  if (!data.ok) {
    return { status: "error", reason: data.reason };
  }
  const configuredMin = props.min === undefined ? undefined : toFiniteNumber(props.min);
  const configuredMax = props.max === undefined ? undefined : toFiniteNumber(props.max);
  if (
    (props.min !== undefined && configuredMin === undefined) ||
    (props.max !== undefined && configuredMax === undefined)
  ) {
    return { status: "error", reason: "chart bounds must be finite numbers" };
  }
  if (
    configuredMin !== undefined &&
    configuredMax !== undefined &&
    configuredMin >= configuredMax
  ) {
    return { status: "error", reason: "chart minimum must be less than maximum" };
  }
  if (data.values.length === 0) {
    return { status: "empty" };
  }
  const dataMin = Math.min(...data.values);
  const dataMax = Math.max(...data.values);
  const includesZeroByDefault = rawType === "bar" || rawType === "gauge";
  let min = configuredMin ?? (includesZeroByDefault ? Math.min(dataMin, 0) : dataMin);
  let max = configuredMax ?? (includesZeroByDefault ? Math.max(dataMax, 0) : dataMax);
  if (min >= max) {
    if (configuredMin !== undefined) {
      const expanded = greaterFiniteBound(min);
      if (expanded === undefined) {
        return { status: "error", reason: "chart bounds cannot form a finite range" };
      }
      max = expanded;
    } else if (configuredMax !== undefined) {
      const expanded = lesserFiniteBound(max);
      if (expanded === undefined) {
        return { status: "error", reason: "chart bounds cannot form a finite range" };
      }
      min = expanded;
    } else if (min > 0) {
      min = lesserFiniteBound(min) ?? min;
    } else if (max < 0) {
      max = greaterFiniteBound(max) ?? max;
    } else {
      min = -1;
      max = 1;
    }
  }
  return {
    status: "ready",
    type: rawType as ChartType,
    values: data.values,
    min,
    max,
    dataMin,
    dataMax,
  };
}

function xScale(index: number, count: number): number {
  return count === 1
    ? VIEW_WIDTH / 2
    : PADDING + (index / (count - 1)) * (VIEW_WIDTH - PADDING * 2);
}

function yScale(value: number, min: number, max: number): number {
  const boundedValue = Math.min(Math.max(value, min), max);
  const scale = Math.max(Math.abs(boundedValue), Math.abs(min), Math.abs(max), 1);
  const fraction = (boundedValue / scale - min / scale) / (max / scale - min / scale);
  return VIEW_HEIGHT - PADDING - fraction * (VIEW_HEIGHT - PADDING * 2);
}

function linePoints(model: Extract<ChartModel, { status: "ready" }>): string {
  return model.values
    .map(
      (value, index) =>
        `${xScale(index, model.values.length)},${yScale(value, model.min, model.max)}`,
    )
    .join(" ");
}

function drawLine(model: Extract<ChartModel, { status: "ready" }>): SVGTemplateResult {
  if (model.values.length === 1) {
    return svg`<circle
      class="workspace-chart__point"
      cx=${xScale(0, 1)}
      cy=${yScale(model.values[0]!, model.min, model.max)}
      r="1.5"
    />`;
  }
  return svg`<polyline class="workspace-chart__line" fill="none" points=${linePoints(model)} />`;
}

function drawArea(model: Extract<ChartModel, { status: "ready" }>): SVGTemplateResult {
  const first = xScale(0, model.values.length);
  const last = xScale(model.values.length - 1, model.values.length);
  const baseline = VIEW_HEIGHT - PADDING;
  return svg`<g>
    <polygon class="workspace-chart__area" points=${`${first},${baseline} ${linePoints(model)} ${last},${baseline}`} />
    ${drawLine(model)}
  </g>`;
}

function drawBars(model: Extract<ChartModel, { status: "ready" }>): SVGTemplateResult {
  const slot = (VIEW_WIDTH - PADDING * 2) / model.values.length;
  const gap = Math.min(1, slot * 0.2);
  const baseline = yScale(Math.min(Math.max(0, model.min), model.max), model.min, model.max);
  return svg`<g class="workspace-chart__bars">
    ${model.values.map((value, index) => {
      const y = yScale(value, model.min, model.max);
      const height = Math.abs(baseline - y);
      return svg`<rect
        x=${PADDING + index * slot + gap / 2}
        y=${Math.min(y, baseline)}
        width=${slot - gap}
        height=${height === 0 ? 0 : Math.max(height, 0.5)}
      />`;
    })}
  </g>`;
}

function drawGauge(model: Extract<ChartModel, { status: "ready" }>): SVGTemplateResult {
  const current = model.values.at(-1) ?? model.min;
  const scale = Math.max(Math.abs(current), Math.abs(model.min), Math.abs(model.max), 1);
  const fraction = (current / scale - model.min / scale) / (model.max / scale - model.min / scale);
  const bounded = Math.min(Math.max(fraction, 0), 1);
  const centerX = VIEW_WIDTH / 2;
  const centerY = VIEW_HEIGHT - PADDING;
  const radius = VIEW_HEIGHT - PADDING * 2;
  const polar = (position: number) => {
    const angle = Math.PI - position * Math.PI;
    return {
      x: centerX + radius * Math.cos(angle),
      y: centerY - radius * Math.sin(angle),
    };
  };
  const start = polar(0);
  const end = polar(1);
  const currentPoint = polar(bounded);
  return svg`<g class="workspace-chart__gauge">
    <path class="workspace-chart__gauge-track" fill="none" d=${`M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${end.x} ${end.y}`} />
    <path class="workspace-chart__gauge-fill" fill="none" d=${`M ${start.x} ${start.y} A ${radius} ${radius} 0 0 1 ${currentPoint.x} ${currentPoint.y}`} />
    <line class="workspace-chart__gauge-needle" x1=${centerX} y1=${centerY} x2=${currentPoint.x} y2=${currentPoint.y} />
  </g>`;
}

function drawChart(model: Extract<ChartModel, { status: "ready" }>): SVGTemplateResult {
  switch (model.type) {
    case "bar":
      return drawBars(model);
    case "area":
      return drawArea(model);
    case "gauge":
      return drawGauge(model);
    default:
      return drawLine(model);
  }
}

export function renderChart(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapChart(widget, value);
  if (model.status === "empty") {
    return html`<div class="workspace-widget__placeholder" data-test-id="workspace-chart-empty">
      ${t("workspaces.widget.chart.empty")}
    </div>`;
  }
  if (model.status === "error") {
    return html`<div
      class="workspace-widget__error"
      data-test-id="workspace-chart-error"
      role="status"
    >
      <span class="workspace-widget__error-title">${t("workspaces.widget.chart.invalid")}</span>
    </div>`;
  }
  const label = widget.title || t("workspaces.widget.chart.label");
  return html`<div class="workspace-chart workspace-chart--${model.type}">
    <svg
      class="workspace-chart__svg"
      viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}"
      preserveAspectRatio="none"
      role="img"
      aria-label=${t("workspaces.widget.chart.summary", {
        title: label,
        count: String(model.values.length),
        min: String(model.dataMin),
        max: String(model.dataMax),
      })}
      data-test-id="workspace-chart"
    >
      ${drawChart(model)}
    </svg>
  </div>`;
}
