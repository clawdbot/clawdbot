import { expectDefined, isRecord } from "@openclaw/normalization-core";
import type { ChatSplitColumn, ChatSplitLayout, ChatSplitPane } from "./split-layout-types.ts";

export function normalizeSplitLayoutWeights(weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

export function splitLayoutNumericSuffix(id: string, prefix: string): number {
  const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id);
  return match ? Number(match[1]) : 0;
}

function readWeights(value: unknown, length: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((weight) => typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0)
  ) {
    return Array.from({ length }, () => 1 / length);
  }
  return normalizeSplitLayoutWeights(value);
}

function uniqueId(value: unknown, used: Set<string>, next: () => string): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate && !used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let generated = next();
  while (used.has(generated)) {
    generated = next();
  }
  used.add(generated);
  return generated;
}

export function normalizeChatSplitLayout(value: unknown): ChatSplitLayout | undefined {
  if (!isRecord(value) || !Array.isArray(value.columns)) {
    return undefined;
  }
  const rawColumns = value.columns.filter(isRecord);
  let paneSequence = rawColumns.reduce((max, rawColumn) => {
    if (!Array.isArray(rawColumn.panes)) {
      return max;
    }
    return rawColumn.panes.reduce((paneMax, rawPane) => {
      if (!isRecord(rawPane) || typeof rawPane.id !== "string") {
        return paneMax;
      }
      return Math.max(paneMax, splitLayoutNumericSuffix(rawPane.id.trim(), "p"));
    }, max);
  }, 0);
  let columnSequence = rawColumns.reduce(
    (max, rawColumn) =>
      typeof rawColumn.id === "string"
        ? Math.max(max, splitLayoutNumericSuffix(rawColumn.id.trim(), "c"))
        : max,
    0,
  );
  const usedPaneIds = new Set<string>();
  const usedColumnIds = new Set<string>();
  const columns: ChatSplitColumn[] = [];
  const sourceColumnIndexes: number[] = [];
  for (const [columnIndex, rawColumn] of rawColumns.entries()) {
    if (!Array.isArray(rawColumn.panes)) {
      continue;
    }
    const panes: ChatSplitPane[] = [];
    const sourcePaneIndexes: number[] = [];
    for (const [paneIndex, rawPane] of rawColumn.panes.entries()) {
      if (!isRecord(rawPane) || typeof rawPane.sessionKey !== "string") {
        continue;
      }
      const sessionKey = rawPane.sessionKey.trim();
      if (!sessionKey) {
        continue;
      }
      panes.push({
        id: uniqueId(rawPane.id, usedPaneIds, () => `p${++paneSequence}`),
        sessionKey,
      });
      sourcePaneIndexes.push(paneIndex);
    }
    if (panes.length === 0) {
      continue;
    }
    const rawPaneWeights = readWeights(rawColumn.paneWeights, rawColumn.panes.length);
    const paneWeights = normalizeSplitLayoutWeights(
      sourcePaneIndexes.map((index) =>
        expectDefined(rawPaneWeights[index], "normalized split pane source weight"),
      ),
    );
    columns.push({
      id: uniqueId(rawColumn.id, usedColumnIds, () => `c${++columnSequence}`),
      panes,
      paneWeights,
    });
    sourceColumnIndexes.push(columnIndex);
  }
  if (columns.length === 0) {
    return undefined;
  }
  const rawColumnWeights = readWeights(value.columnWeights, rawColumns.length);
  const columnWeights = normalizeSplitLayoutWeights(
    sourceColumnIndexes.map((index) =>
      expectDefined(rawColumnWeights[index], "normalized split column source weight"),
    ),
  );
  const allPanes = columns.flatMap((column) => column.panes);
  if (allPanes.length < 2) {
    return undefined;
  }
  const requestedActivePaneId =
    typeof value.activePaneId === "string" ? value.activePaneId.trim() : "";
  const activePaneId = allPanes.some((pane) => pane.id === requestedActivePaneId)
    ? requestedActivePaneId
    : expectDefined(allPanes[0], "normalized split layout first pane").id;
  return { columns, columnWeights, activePaneId };
}
