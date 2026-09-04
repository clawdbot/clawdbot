// Generic text-report primitives for status command output.
// Callers assemble typed sections; this file owns heading insertion and table rendering order.

import type { RenderTableOptions, TableColumn } from "../../../packages/terminal-core/src/table.js";

type HeadingFn = (text: string) => string;
type TableRenderer = (input: RenderTableOptions) => string;

export type StatusReportSection =
  | {
      kind: "lines";
      title: string;
      body: string[];
      skipIfEmpty?: boolean;
    }
  | {
      kind: "table";
      title: string;
      columns: readonly TableColumn[];
      rows: Array<Record<string, string>>;
      trailer?: string | null;
      skipIfEmpty?: boolean;
    }
  | {
      kind: "raw";
      body: string[];
      skipIfEmpty?: boolean;
    };

/** Appends a blank-line-separated section heading. */
export function appendStatusSectionHeading(params: {
  lines: string[];
  heading: HeadingFn;
  title: string;
}) {
  if (params.lines.length > 0) {
    params.lines.push("");
  }
  params.lines.push(params.heading(params.title));
}

/** Appends report sections in display order, honoring explicit empty-section skipping. */
export function appendStatusReportSections(params: {
  lines: string[];
  heading: HeadingFn;
  width: number;
  renderTable: TableRenderer;
  sections: StatusReportSection[];
}) {
  for (const section of params.sections) {
    const content = section.kind === "table" ? section.rows : section.body;
    if (section.skipIfEmpty && content.length === 0) {
      continue;
    }
    if (section.kind === "raw") {
      params.lines.push(...section.body);
      continue;
    }
    appendStatusSectionHeading({
      lines: params.lines,
      heading: params.heading,
      title: section.title,
    });
    if (section.kind === "lines") {
      params.lines.push(...section.body);
      continue;
    }
    params.lines.push(
      params
        .renderTable({
          width: params.width,
          columns: [...section.columns],
          rows: section.rows,
        })
        .trimEnd(),
    );
    if (section.trailer) {
      params.lines.push(section.trailer);
    }
  }
}
