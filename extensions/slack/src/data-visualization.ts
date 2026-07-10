// Slack data-visualization Block Kit contract, projection, and text fallback.
import type { Block } from "@slack/web-api";
import {
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  type MessagePresentationChartBlock,
} from "openclaw/plugin-sdk/interactive-runtime";

export const SLACK_CHART_TITLE_MAX = 50;
export const SLACK_CHART_LABEL_MAX = 20;
export const SLACK_CHART_AXIS_LABEL_MAX = 50;
export const SLACK_CHART_SERIES_MAX = 12;
export const SLACK_CHART_DATA_POINTS_MAX = 20;
// Slack's API rejects a third data_visualization block even though its public
// reference does not currently document this per-message subtype limit.
export const SLACK_DATA_VISUALIZATION_BLOCKS_MAX = 2;

type SlackChartDatum = { label: string; value: number };

type SlackPieChart = {
  type: "pie";
  segments: SlackChartDatum[];
};

type SlackSeriesChart = {
  type: "bar" | "area" | "line";
  series: Array<{ name: string; data: SlackChartDatum[] }>;
  axis_config: {
    categories: string[];
    x_label?: string;
    y_label?: string;
  };
};

export type SlackDataVisualizationBlock = Block & {
  type: "data_visualization";
  title: string;
  chart: SlackPieChart | SlackSeriesChart;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Detect native chart blocks without depending on unreleased Slack SDK types. */
export function hasSlackDataVisualizationBlock(blocks?: readonly unknown[]): boolean {
  return blocks?.some((block) => asRecord(block)?.type === "data_visualization") ?? false;
}

/** Match Slack's Web API and response_url `invalid_blocks` error shapes. */
export function isSlackInvalidBlocksError(error: unknown): boolean {
  const record = asRecord(error);
  const rawData = record?.data;
  const data = asRecord(rawData);
  const rawResponseData = asRecord(record?.response)?.data;
  const responseData = asRecord(rawResponseData);
  const code =
    data?.error ??
    (typeof rawData === "string" ? rawData : undefined) ??
    responseData?.error ??
    (typeof rawResponseData === "string" ? rawResponseData : undefined) ??
    record?.error;
  return typeof code === "string" && code.trim().toLowerCase() === "invalid_blocks";
}

function isStringWithin(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= maxLength
  );
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** True when a portable chart satisfies Slack's complete native-block contract. */
export function canRenderSlackDataVisualization(block: MessagePresentationChartBlock): boolean {
  if (!isStringWithin(block.title, SLACK_CHART_TITLE_MAX)) {
    return false;
  }
  if (block.chartType === "pie") {
    return (
      block.segments.length >= 1 &&
      block.segments.length <= SLACK_CHART_SERIES_MAX &&
      block.segments.every(
        (segment) =>
          isStringWithin(segment.label, SLACK_CHART_LABEL_MAX) &&
          Number.isFinite(segment.value) &&
          segment.value > 0,
      )
    );
  }
  if (
    block.categories.length < 1 ||
    block.categories.length > SLACK_CHART_DATA_POINTS_MAX ||
    !block.categories.every((category) => isStringWithin(category, SLACK_CHART_LABEL_MAX)) ||
    !hasUniqueStrings(block.categories) ||
    block.series.length < 1 ||
    block.series.length > SLACK_CHART_SERIES_MAX ||
    !hasUniqueStrings(block.series.map((series) => series.name)) ||
    (block.xLabel !== undefined && !isStringWithin(block.xLabel, SLACK_CHART_AXIS_LABEL_MAX)) ||
    (block.yLabel !== undefined && !isStringWithin(block.yLabel, SLACK_CHART_AXIS_LABEL_MAX))
  ) {
    return false;
  }
  return block.series.every(
    (series) =>
      isStringWithin(series.name, SLACK_CHART_LABEL_MAX) &&
      series.values.length === block.categories.length &&
      series.values.every((value) => Number.isFinite(value)),
  );
}

/** Map a validated portable chart to Slack's app-facing Block Kit shape. */
export function buildSlackDataVisualizationBlock(
  block: MessagePresentationChartBlock,
): SlackDataVisualizationBlock | undefined {
  if (!canRenderSlackDataVisualization(block)) {
    return undefined;
  }
  if (block.chartType === "pie") {
    return {
      type: "data_visualization",
      title: block.title,
      chart: {
        type: "pie",
        segments: block.segments.map((segment) => ({ ...segment })),
      },
    };
  }
  return {
    type: "data_visualization",
    title: block.title,
    chart: {
      type: block.chartType,
      series: block.series.map((series) => ({
        name: series.name,
        data: block.categories.map((label, index) => ({
          label,
          value: series.values[index]!,
        })),
      })),
      axis_config: {
        categories: [...block.categories],
        ...(block.xLabel ? { x_label: block.xLabel } : {}),
        ...(block.yLabel ? { y_label: block.yLabel } : {}),
      },
    },
  };
}

function readSlackChartDatum(value: unknown): SlackChartDatum | undefined {
  const record = asRecord(value);
  const label = record?.label;
  const datumValue = record?.value;
  return typeof label === "string" && typeof datumValue === "number"
    ? { label, value: datumValue }
    : undefined;
}

function parseSlackDataVisualizationBlock(
  value: unknown,
): MessagePresentationChartBlock | undefined {
  const block = asRecord(value);
  const title = block?.title;
  const chart = asRecord(block?.chart);
  if (block?.type !== "data_visualization" || typeof title !== "string" || !chart) {
    return undefined;
  }
  if (chart.type === "pie") {
    if (!Array.isArray(chart.segments)) {
      return undefined;
    }
    const segments = chart.segments.map(readSlackChartDatum);
    if (segments.some((segment) => !segment)) {
      return undefined;
    }
    const normalized = normalizeMessagePresentation({
      blocks: [{ type: "chart", chartType: "pie", title, segments }],
    });
    const normalizedBlock = normalized?.blocks[0];
    return normalizedBlock?.type === "chart" ? normalizedBlock : undefined;
  }
  if (chart.type !== "bar" && chart.type !== "area" && chart.type !== "line") {
    return undefined;
  }
  const axisConfig = asRecord(chart.axis_config);
  const categories = axisConfig?.categories;
  if (!Array.isArray(categories) || !categories.every((category) => typeof category === "string")) {
    return undefined;
  }
  if (!Array.isArray(chart.series)) {
    return undefined;
  }
  const series = chart.series.map((rawSeries) => {
    const seriesRecord = asRecord(rawSeries);
    if (typeof seriesRecord?.name !== "string" || !Array.isArray(seriesRecord.data)) {
      return undefined;
    }
    const data = seriesRecord.data.map(readSlackChartDatum);
    if (data.some((datum) => !datum) || data.length !== categories.length) {
      return undefined;
    }
    const dataByLabel = new Map(data.map((datum) => [datum!.label, datum!.value]));
    if (
      dataByLabel.size !== data.length ||
      categories.some((category) => !dataByLabel.has(category))
    ) {
      return undefined;
    }
    return {
      name: seriesRecord.name,
      values: categories.map((category) => dataByLabel.get(category)!),
    };
  });
  if (series.some((entry) => !entry)) {
    return undefined;
  }
  const normalized = normalizeMessagePresentation({
    blocks: [
      {
        type: "chart",
        chartType: chart.type,
        title,
        categories,
        series,
        xLabel: axisConfig?.x_label,
        yLabel: axisConfig?.y_label,
      },
    ],
  });
  const normalizedBlock = normalized?.blocks[0];
  return normalizedBlock?.type === "chart" ? normalizedBlock : undefined;
}

/** Extract a deterministic accessible summary from a native Slack chart block. */
export function renderSlackDataVisualizationFallbackText(value: unknown): string | undefined {
  const block = asRecord(value);
  if (block?.type !== "data_visualization") {
    return undefined;
  }
  const parsed = parseSlackDataVisualizationBlock(block);
  if (parsed) {
    return renderMessagePresentationChartFallbackText(parsed);
  }
  return typeof block.title === "string" && block.title.trim() ? block.title.trim() : undefined;
}

/** Preserve every native chart's data when Slack requires a text-only retry. */
export function appendSlackDataVisualizationFallbackText(
  text: string,
  blocks?: readonly unknown[],
): string {
  const base = text.trim();
  const comparableBase = base.replace(/\s+/gu, " ");
  const chartTexts = (blocks ?? [])
    .map(renderSlackDataVisualizationFallbackText)
    .filter((chartText): chartText is string => Boolean(chartText))
    .filter((chartText) => !comparableBase.includes(chartText.replace(/\s+/gu, " ")));
  return [base, ...chartTexts].filter(Boolean).join("\n\n");
}
