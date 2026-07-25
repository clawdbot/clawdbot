// Shared detection and text fallback for Slack's native chart and table blocks.
import { renderSlackBlockFallbackText } from "./blocks-fallback.js";
import {
  hasSlackDataTableBlock,
  renderSlackDataTableCompactPlainTextFallback,
  renderSlackDataTableMrkdwnFallbackText,
} from "./data-table.js";
import {
  hasSlackDataVisualizationBlock,
  renderSlackDataVisualizationFallbackText,
  renderSlackDataVisualizationMrkdwnFallbackText,
} from "./data-visualization.js";

export const SLACK_MALFORMED_NATIVE_DATA_FALLBACK =
  "Slack could not render this chart or table data.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Detect a native Slack chart or table block. */
export function hasSlackNativeDataBlock(blocks?: readonly unknown[]): boolean {
  return hasSlackDataVisualizationBlock(blocks) || hasSlackDataTableBlock(blocks);
}

/** Keep every sibling block while removing Slack's native data blocks. */
export function stripSlackNativeDataBlocks<T>(blocks?: readonly T[]): T[] {
  return (blocks ?? []).filter((block) => {
    const type = asRecord(block)?.type;
    return type !== "data_table" && type !== "data_visualization";
  });
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

type SlackResponseLike = {
  status: number;
  clone: () => { text: () => Promise<string> };
};

function isSlackResponseLike(value: unknown): value is SlackResponseLike {
  const record = asRecord(value);
  return typeof record?.status === "number" && typeof record.clone === "function";
}

/** Inspect Bolt 5's native response_url Response without consuming the caller's body. */
export async function isSlackInvalidBlocksResponse(response: unknown): Promise<boolean> {
  if (!isSlackResponseLike(response)) {
    return isSlackInvalidBlocksError(response);
  }
  try {
    const body = await response.clone().text();
    if (body.trim().toLowerCase() === "invalid_blocks") {
      return true;
    }
    return isSlackInvalidBlocksError(JSON.parse(body));
  } catch {
    return false;
  }
}

/** Bolt 5 omits the response body from RespondError; 400 is contextual here. */
export function isSlackNativeResponseUrlRejection(error: unknown): boolean {
  if (isSlackInvalidBlocksError(error)) {
    return true;
  }
  const record = asRecord(error);
  return record?.code === "slack_bolt_respond_error" && record.statusCode === 400;
}

/** Extract a complete accessible summary from a supported native data block. */
function renderSlackNativeDataFallbackText(value: unknown): string | undefined {
  const type = asRecord(value)?.type;
  if (type === "data_visualization") {
    return renderSlackDataVisualizationMrkdwnFallbackText(value);
  }
  if (type === "data_table") {
    return renderSlackDataTableMrkdwnFallbackText(value);
  }
  return undefined;
}

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function countComparableOccurrences(value: string, candidate: string): number {
  if (!candidate) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(candidate, offset)) >= 0) {
    count += 1;
    offset += candidate.length;
  }
  return count;
}

/** Consume native fallback occurrences already carried by an explicit outside base. */
export function createSlackNativeDataBaseTextConsumer(baseText: string): (text: string) => boolean {
  const comparableBase = comparableText(baseText);
  const remainingByText = new Map<string, number>();
  return (text) => {
    const comparable = comparableText(text);
    const remaining =
      remainingByText.get(comparable) ?? countComparableOccurrences(comparableBase, comparable);
    if (remaining <= 0) {
      return false;
    }
    remainingByText.set(comparable, remaining - 1);
    return true;
  };
}

function appendSlackNativeDataFallback(
  text: string,
  blocks: readonly unknown[] | undefined,
  render: (value: unknown) => string | undefined,
): string {
  const base = text.trim();
  const consumeFromBase = createSlackNativeDataBaseTextConsumer(base);
  const dataTexts: string[] = [];
  for (const block of blocks ?? []) {
    const dataText = render(block);
    if (!dataText) {
      continue;
    }
    if (!comparableText(dataText) || consumeFromBase(dataText)) {
      continue;
    }
    dataTexts.push(dataText);
  }
  return [base, ...dataTexts].filter(Boolean).join("\n\n");
}

function renderSlackNativeDataPlainTextBlock(value: unknown): string | undefined {
  const type = asRecord(value)?.type;
  if (type === "data_table") {
    return renderSlackDataTableCompactPlainTextFallback(value);
  }
  if (type === "data_visualization") {
    return renderSlackDataVisualizationFallbackText(value);
  }
  return undefined;
}

/** Build formatting-disabled accessibility text from actual Slack block order. */
export function buildSlackNativeDataAccessibilityText(
  text: string,
  blocks?: readonly unknown[],
): string {
  const parts: string[] = [];
  const consumeFromBase = createSlackNativeDataBaseTextConsumer(text);
  const append = (value: string | undefined) => {
    if (value?.trim()) {
      parts.push(value);
    }
  };
  append(text);
  for (const block of blocks ?? []) {
    const isNativeData = hasSlackNativeDataBlock([block]);
    const rendered =
      renderSlackNativeDataPlainTextBlock(block) ??
      renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" }) ??
      (isNativeData ? SLACK_MALFORMED_NATIVE_DATA_FALLBACK : undefined);
    if (!rendered || (isNativeData && consumeFromBase(rendered))) {
      continue;
    }
    append(rendered);
  }
  return parts.join("\n\n");
}

/** Preserve every native data block's content once when Slack requires a text-only retry. */
export function appendSlackNativeDataFallbackText(
  text: string,
  blocks?: readonly unknown[],
): string {
  return appendSlackNativeDataFallback(text, blocks, renderSlackNativeDataFallbackText);
}

/** Build a bounded plain-text retry without activating control tokens. */
export function appendSlackNativeDataPlainTextFallback(
  text: string,
  blocks?: readonly unknown[],
): string {
  return appendSlackNativeDataFallback(text, blocks, renderSlackNativeDataPlainTextBlock);
}
