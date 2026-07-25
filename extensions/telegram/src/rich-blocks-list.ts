import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import type { InputRichBlock, InputRichBlockListItem } from "./rich-block-model.js";

type MarkdownRichListItemSource = {
  kind: "bullet" | "ordered";
  start: number;
  end: number;
  contentStart: number;
  task: boolean;
  checked: boolean;
  value?: number;
};

export type MarkdownRichListSource = {
  start: number;
  end: number;
  items: MarkdownRichListItemSource[];
};

/** Groups exact parser-owned item spans by list identity without reparsing Markdown. */
export function collectMarkdownRichListSources(ir: MarkdownIR): MarkdownRichListSource[] {
  const byListId = new Map<number, MarkdownRichListItemSource[]>();
  for (const item of ir.listItems ?? []) {
    if (
      !item.listMarker ||
      item.listId === undefined ||
      item.start === undefined ||
      item.end === undefined
    ) {
      continue;
    }
    const markerText = ir.text.slice(item.listMarker.start, item.listMarker.end);
    const taskText = item.taskMarker
      ? ir.text.slice(item.taskMarker.start, item.taskMarker.end)
      : "";
    const value = item.kind === "ordered" ? Number.parseInt(markerText, 10) : undefined;
    const source = {
      kind: item.kind,
      start: item.start,
      end: item.end,
      contentStart: item.taskMarker?.end ?? item.listMarker.end,
      task: item.task === true,
      checked: /^\[[xX]\]/u.test(taskText),
      ...(value !== undefined && Number.isFinite(value) ? { value } : {}),
    } satisfies MarkdownRichListItemSource;
    const list = byListId.get(item.listId) ?? [];
    list.push(source);
    byListId.set(item.listId, list);
  }
  return [...byListId.values()].map((items) => {
    items.sort((left, right) => left.start - right.start);
    return {
      start: Math.min(...items.map((item) => item.start)),
      end: Math.max(...items.map((item) => item.end)),
      items,
    };
  });
}

type RenderRange = (start: number, end: number) => InputRichBlock[];

/** Renders one parser list; nested containers arrive through renderRange. */
export function renderMarkdownRichListSource(
  source: MarkdownRichListSource,
  renderRange: RenderRange,
): InputRichBlock[] | undefined {
  const kind = source.items[0]?.kind;
  if (!kind || source.items.some((item) => item.kind !== kind)) {
    return undefined;
  }
  const items: InputRichBlockListItem[] = source.items.map((item) => {
    const blocks = renderRange(item.contentStart, item.end);
    return {
      blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
      ...(item.task ? { has_checkbox: true as const } : {}),
      ...(item.checked ? { is_checked: true as const } : {}),
      ...(kind === "ordered" && item.value !== undefined ? { value: item.value } : {}),
    };
  });
  return [{ type: "list", items }];
}
