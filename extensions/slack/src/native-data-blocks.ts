// Shared detection and text fallback for Slack's native chart and table blocks.
import type { Block, KnownBlock } from "@slack/web-api";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { hasSlackDataTableBlock, renderSlackDataTableMrkdwnFallbackText } from "./data-table.js";
import {
  hasSlackDataVisualizationBlock,
  renderSlackDataVisualizationMrkdwnFallbackText,
} from "./data-visualization.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Detect a native Slack chart or table block. */
export function hasSlackNativeDataBlock(blocks?: readonly unknown[]): boolean {
  return hasSlackDataVisualizationBlock(blocks) || hasSlackDataTableBlock(blocks);
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

/** Extract a complete accessible summary from a supported native data block. */
export function renderSlackNativeDataFallbackText(value: unknown): string | undefined {
  const type = asRecord(value)?.type;
  if (type === "data_visualization") {
    return renderSlackDataVisualizationMrkdwnFallbackText(value);
  }
  if (type === "data_table") {
    return renderSlackDataTableMrkdwnFallbackText(value);
  }
  return undefined;
}

/** Replace rejected native data with visible mrkdwn while retaining valid sibling blocks. */
export function buildSlackNativeDataFallbackBlocks(
  blocks?: readonly (Block | KnownBlock)[],
): (Block | KnownBlock)[] | undefined {
  if (!blocks) {
    return undefined;
  }
  const fallbackBlocks: (Block | KnownBlock)[] = [];
  for (const block of blocks) {
    const fallbackText = renderSlackNativeDataFallbackText(block);
    if (!fallbackText) {
      fallbackBlocks.push(block);
      continue;
    }
    fallbackBlocks.push(
      ...chunkTextForOutbound(fallbackText, SLACK_SECTION_TEXT_MAX).map(
        (text): KnownBlock => ({
          type: "section",
          text: { type: "mrkdwn", text, verbatim: true },
        }),
      ),
    );
  }
  if (fallbackBlocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(
      `Slack native-data fallback requires ${String(fallbackBlocks.length)} blocks to retain every sibling; Slack allows ${String(SLACK_MAX_BLOCKS)}`,
    );
  }
  return fallbackBlocks;
}

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** True when text already contains every attached native-data fallback in full. */
export function hasCompleteSlackNativeDataFallbackText(
  text: string,
  blocks?: readonly unknown[],
): boolean {
  const comparableBase = comparableText(text);
  let hasNativeDataFallback = false;
  for (const block of blocks ?? []) {
    const dataText = renderSlackNativeDataFallbackText(block);
    if (!dataText) {
      continue;
    }
    hasNativeDataFallback = true;
    const comparable = comparableText(dataText);
    if (!comparable || !comparableBase.includes(comparable)) {
      return false;
    }
  }
  return hasNativeDataFallback;
}

/** Preserve every native data block's content once in the accessible fallback. */
export function appendSlackNativeDataFallbackText(
  text: string,
  blocks?: readonly unknown[],
): string {
  const base = text.trim();
  const comparableBase = comparableText(base);
  const seen = new Set<string>();
  const dataTexts: string[] = [];
  for (const block of blocks ?? []) {
    const dataText = renderSlackNativeDataFallbackText(block);
    if (!dataText) {
      continue;
    }
    const comparable = comparableText(dataText);
    if (!comparable || comparableBase.includes(comparable) || seen.has(comparable)) {
      continue;
    }
    seen.add(comparable);
    dataTexts.push(dataText);
  }
  return [base, ...dataTexts].filter(Boolean).join("\n\n");
}
