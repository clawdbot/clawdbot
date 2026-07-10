/**
 * Aggregate summaries for a run of consecutive tool calls, e.g.
 * "Ran 13 commands, read 6 files, edited 9 files, created a file".
 */

import { t } from "../../i18n/index.ts";
import {
  resolveToolCallKind,
  resolveToolCallTargetPaths,
  type ToolCallKind,
} from "./tool-call-view.ts";

export type ToolGroupSummaryInput = {
  name: string;
  args?: unknown;
  isError?: boolean;
};

type GroupCounts = {
  commands: number;
  readPaths: Set<string>;
  reads: number;
  editPaths: Set<string>;
  edits: number;
  writePaths: Set<string>;
  writes: number;
  searches: number;
  fetches: number;
  otherNames: Set<string>;
  others: number;
  failed: number;
};

function countCard(counts: GroupCounts, card: ToolGroupSummaryInput): void {
  const kind: ToolCallKind = resolveToolCallKind(card.name, card.args);
  const pathKeys = resolveToolCallTargetPaths(card.name, card.args);
  const addPaths = (target: Set<string>) => {
    for (const path of pathKeys) {
      if (path.trim()) {
        target.add(path.trim());
      }
    }
  };
  switch (kind) {
    case "command":
      counts.commands += 1;
      break;
    case "read":
      counts.reads += 1;
      addPaths(counts.readPaths);
      break;
    case "edit":
      counts.edits += 1;
      addPaths(counts.editPaths);
      break;
    case "write":
      counts.writes += 1;
      addPaths(counts.writePaths);
      break;
    case "search":
      counts.searches += 1;
      break;
    case "fetch":
      counts.fetches += 1;
      break;
    default:
      counts.others += 1;
      counts.otherNames.add(card.name);
  }
  if (card.isError) {
    counts.failed += 1;
  }
}

function countLabel(count: number, oneKey: string, manyKey: string): string {
  return t(count === 1 ? oneKey : manyKey, { count: String(count) });
}

function fileCount(calls: number, paths: Set<string>): number {
  return paths.size > 0 ? paths.size : calls;
}

/**
 * Build the collapsed group label. The first segment carries the verb
 * ("Ran 13 commands"); later segments continue lowercase ("read 6 files").
 */
export function summarizeToolGroup(cards: readonly ToolGroupSummaryInput[]): string {
  const counts: GroupCounts = {
    commands: 0,
    readPaths: new Set(),
    reads: 0,
    editPaths: new Set(),
    edits: 0,
    writePaths: new Set(),
    writes: 0,
    searches: 0,
    fetches: 0,
    otherNames: new Set(),
    others: 0,
    failed: 0,
  };
  for (const card of cards) {
    countCard(counts, card);
  }

  const segments: string[] = [];
  if (counts.commands > 0) {
    segments.push(
      countLabel(
        counts.commands,
        "chat.toolCards.group.commandsOne",
        "chat.toolCards.group.commandsMany",
      ),
    );
  }
  if (counts.reads > 0) {
    segments.push(
      countLabel(
        fileCount(counts.reads, counts.readPaths),
        "chat.toolCards.group.readsOne",
        "chat.toolCards.group.readsMany",
      ),
    );
  }
  if (counts.edits > 0) {
    segments.push(
      countLabel(
        fileCount(counts.edits, counts.editPaths),
        "chat.toolCards.group.editsOne",
        "chat.toolCards.group.editsMany",
      ),
    );
  }
  if (counts.writes > 0) {
    segments.push(
      countLabel(
        fileCount(counts.writes, counts.writePaths),
        "chat.toolCards.group.writesOne",
        "chat.toolCards.group.writesMany",
      ),
    );
  }
  if (counts.searches > 0) {
    segments.push(
      countLabel(
        counts.searches,
        "chat.toolCards.group.searchesOne",
        "chat.toolCards.group.searchesMany",
      ),
    );
  }
  if (counts.fetches > 0) {
    segments.push(
      countLabel(
        counts.fetches,
        "chat.toolCards.group.fetchesOne",
        "chat.toolCards.group.fetchesMany",
      ),
    );
  }
  if (counts.others > 0) {
    const names = [...counts.otherNames].slice(0, 2).join(", ");
    segments.push(
      counts.otherNames.size <= 2 && names
        ? t(
            counts.others > counts.otherNames.size
              ? "chat.toolCards.group.namedToolRepeated"
              : "chat.toolCards.group.namedTool",
            { names, count: String(counts.others) },
          )
        : countLabel(
            counts.others,
            "chat.toolCards.group.otherOne",
            "chat.toolCards.group.otherMany",
          ),
    );
  }

  if (segments.length === 0) {
    return countLabel(
      cards.length,
      "chat.toolCards.group.emptyOne",
      "chat.toolCards.group.emptyMany",
    );
  }
  const label = segments.join(", ");
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  if (counts.failed === 0) {
    return capitalized;
  }
  const failureLabel = countLabel(
    counts.failed,
    "chat.toolCards.group.failedOne",
    "chat.toolCards.group.failedMany",
  );
  return `${capitalized} · ${failureLabel}`;
}
