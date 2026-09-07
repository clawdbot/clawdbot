import { truncateUtf8Prefix } from "../../../utils/utf8-truncate.js";
import {
  estimateToolResultTextChars,
  sliceToolResultTextToBudget,
} from "../../embedded-agent-runner/tool-result-text-budget.js";
import { toolResultFitsBudget, type ToolResultBudget } from "../../tool-result-limits.js";
import type { ReadToolContinuation, ReadToolDetails } from "./tool-contracts.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

type BoundedReadTextPage = {
  details: Extract<ReadToolDetails, { kind: "text" | "truncated" }>;
  text: string;
};

/** Format model-visible pagination guidance from its exact structured continuation. */
export function formatReadContinuationNotice(
  continuation: ReadToolContinuation,
  maxBytes: number,
  range?: { startLine: number; totalLines: number },
): string {
  const cursor = continuation.kind === "cursor" ? `, cursor=${continuation.cursor}` : "";
  const limit = continuation.limit === undefined ? "" : `, limit=${continuation.limit}`;
  if (!range) {
    const budget = formatSize(maxBytes).replace(/\.0(?=KB)/, "");
    return `\n\n[Read output capped at ${budget} for this call. Use offset=${continuation.offset}${cursor}${limit} to continue.]`;
  }
  const label =
    continuation.kind === "cursor"
      ? `part of line ${range.startLine}`
      : `lines ${range.startLine}-${continuation.offset - 1} of ${range.totalLines}`;
  const action = continuation.kind === "cursor" ? "Use read with" : "Use";
  return `\n\n[Showing ${label} (${formatSize(maxBytes)} limit). ${action} offset=${continuation.offset}${cursor}${limit} to continue.]`;
}

/** Bound a selected text page once; legacy injected readers reuse this owner decision. */
export function createBoundedReadTextPage(params: {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** A source page can already be partial before this tighter budget is applied. */
  continuation?: ReadToolContinuation;
  cursor?: number;
  limit?: number;
  maxBytes: number;
  pageMaxBytes?: number;
  modelBudget?: ToolResultBudget;
  /** Caller-owned framing already reserved in pageMaxBytes, never file/cursor content. */
  prefix?: string;
  adaptive?: boolean;
}): BoundedReadTextPage {
  const maxBytes = params.pageMaxBytes ?? Math.min(DEFAULT_MAX_BYTES, params.maxBytes);
  const remainingLines = params.totalLines - params.endLine;
  const limitNotice = params.continuation
    ? formatReadContinuationNotice(params.continuation, params.maxBytes)
    : params.limit !== undefined && remainingLines > 0
      ? `\n\n[${remainingLines} more line${remainingLines === 1 ? "" : "s"} in file. Use offset=${params.endLine + 1} to continue.]`
      : "";
  const contentBytes = Buffer.byteLength(params.content, "utf8");
  const resultPrefix = params.prefix ?? "";
  const completeSelectedPage = (content: string): BoundedReadTextPage => ({
    text: `${content}${limitNotice}`,
    // A complete requested slice is not EOF. Keep the next page machine-readable
    // instead of forcing Code Mode callers to parse the display-only notice.
    details: limitNotice
      ? {
          kind: "truncated",
          content,
          continuation: params.continuation ?? {
            kind: "line",
            offset: params.endLine + 1,
            limit: params.limit,
          },
          truncation: {
            truncated: true,
            truncatedBy: params.continuation?.kind === "cursor" ? "bytes" : "lines",
            totalLines: params.totalLines,
            totalBytes: contentBytes,
            outputLines:
              params.continuation?.kind === "cursor"
                ? params.continuation.offset - params.startLine
                : params.endLine - params.startLine + 1,
            outputBytes: Buffer.byteLength(content, "utf8"),
            lastLinePartial: params.continuation?.kind === "cursor",
            firstLineExceedsLimit: false,
            maxLines: params.limit ?? DEFAULT_MAX_LINES,
            maxBytes,
          },
        }
      : { kind: "text", content },
  });
  if (
    params.endLine - params.startLine < DEFAULT_MAX_LINES &&
    contentBytes + Buffer.byteLength(limitNotice, "utf8") <= maxBytes &&
    toolResultFitsBudget(`${resultPrefix}${params.content}${limitNotice}`, params.modelBudget)
  ) {
    return completeSelectedPage(params.content);
  }

  const range = params.adaptive
    ? undefined
    : { startLine: params.startLine, totalLines: params.totalLines };
  const boundedLimit = params.limit === undefined ? {} : { limit: params.limit };
  const firstLine = params.content.split("\n", 1)[0] ?? "";
  const cursorEstimate: ReadToolContinuation = {
    kind: "cursor",
    offset: params.startLine,
    cursor: (params.cursor ?? 0) + firstLine.length,
    ...boundedLimit,
  };
  const lineEstimate: ReadToolContinuation = {
    kind: "line",
    offset: params.totalLines + 1,
    ...boundedLimit,
  };
  const reservedBytes = Math.max(
    Buffer.byteLength(formatReadContinuationNotice(cursorEstimate, params.maxBytes, range), "utf8"),
    Buffer.byteLength(formatReadContinuationNotice(lineEstimate, params.maxBytes, range), "utf8"),
  );
  let prefix = truncateUtf8Prefix(params.content, Math.max(0, maxBytes - reservedBytes));
  if (params.modelBudget) {
    prefix = sliceToolResultTextToBudget(
      prefix,
      params.modelBudget.maxChars - reservedBytes - estimateToolResultTextChars(resultPrefix),
    );
    prefix = sliceToolResultTextToBudget(
      prefix,
      params.modelBudget.maxContextChars -
        reservedBytes * 2 -
        estimateToolResultTextChars(resultPrefix, { minimumRawWeight: 2 }),
      { minimumRawWeight: 2 },
    );
  }
  // Convert the fitted prefix back to a byte allowance for the existing line/cursor owner.
  // The cursor advances only over text that survives both model limits and its real footer.
  const contentBudgetBytes = Buffer.byteLength(prefix, "utf8");
  const truncation = truncateHead(params.content, { maxBytes: contentBudgetBytes });
  if (!truncation.truncated) {
    return completeSelectedPage(truncation.content);
  }

  let continuation: ReadToolContinuation;
  let content = truncation.content;
  if (truncation.firstLineExceedsLimit) {
    content = truncateUtf8Prefix(firstLine, contentBudgetBytes);
    continuation = {
      kind: "cursor",
      offset: params.startLine,
      cursor: (params.cursor ?? 0) + content.length,
      ...boundedLimit,
    };
  } else {
    const nextOffset = params.startLine + truncation.outputLines;
    continuation = {
      kind: "line",
      offset: nextOffset,
      ...(params.limit === undefined
        ? {}
        : { limit: Math.max(1, params.endLine - nextOffset + 1) }),
    };
  }

  const { content: _content, ...truncationDetails } = truncation;
  return {
    text: `${content}${formatReadContinuationNotice(continuation, params.maxBytes, range)}`,
    details: {
      kind: "truncated",
      content,
      truncation: {
        ...truncationDetails,
        outputBytes: Buffer.byteLength(content, "utf8"),
        firstLineExceedsLimit: false,
        lastLinePartial: continuation.kind === "cursor",
        totalLines: params.totalLines,
      },
      continuation,
    },
  };
}
