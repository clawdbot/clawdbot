import { visibleWidth } from "../../terminal-core/src/ansi.js";

/** Shared bullet layout, including the newline contributed by empty rows. */
export function renderMarkdownTableBullets<T extends { text: string }>(
  headers: readonly T[],
  rows: readonly (readonly T[])[],
  writeText: (text: string) => void,
  writeCell: (cell: T, rowLabel: boolean) => void,
) {
  const labeled = headers.length > 1;
  for (const row of rows) {
    if (labeled && row[0]?.text) {
      writeCell(row[0], true);
      writeText("\n");
    }
    for (let index = labeled ? 1 : 0; index < row.length; index += 1) {
      const value = row[index];
      if (!value?.text) {
        continue;
      }
      writeText("• ");
      const header = headers[index];
      if (header?.text) {
        writeCell(header, false);
        writeText(": ");
      } else if (labeled) {
        writeText(`Column ${index}: `);
      }
      writeCell(value, false);
      writeText("\n");
    }
    writeText("\n");
  }
}

/** Render the existing aligned, plain-text representation without a Markdown fence. */
export function renderMarkdownCodeTable(headers: readonly string[], rows: readonly string[][]) {
  const measured = [headers, ...rows].map((row) =>
    row.map((text) => ({ text, width: visibleWidth(text) })),
  );
  const widths: number[] = [];
  for (const row of measured) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.width);
    }
  }
  if (widths.length === 0) {
    return "";
  }
  const renderRow = (row: (typeof measured)[number]) =>
    `|${widths.map((width, index) => ` ${row[index]?.text ?? ""}${" ".repeat(width - (row[index]?.width ?? 0))} |`).join("")}`;
  const divider = `|${widths.map((width) => ` ${"-".repeat(Math.max(3, width))} |`).join("")}`;
  return [renderRow(measured[0] ?? []), divider, ...measured.slice(1).map(renderRow), ""].join(
    "\n",
  );
}
