// builtin:table — compact table over an array binding (`rows`: file JSON array /
// static / rpc). `props.columns` is a picklist of keys to show (defaults to the
// union of the first row's keys). Shows the first N rows and a "+M more" footer.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import type { WorkspaceWidget } from "../types.ts";
import { isRecord, widgetProps } from "./types.ts";

const DEFAULT_ROW_LIMIT = 8;

export type TableModel = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  shown: number;
  total: number;
};

/** Pull an array of row records out of the binding value or `props.rows`. */
function resolveRows(widget: WorkspaceWidget, value: unknown): Array<Record<string, unknown>> {
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.rows)
      ? value.rows
      : Array.isArray(widgetProps(widget).rows)
        ? (widgetProps(widget).rows as unknown[])
        : [];
  return candidate.filter(isRecord);
}

function resolveColumns(widget: WorkspaceWidget, rows: Array<Record<string, unknown>>): string[] {
  const declared = widgetProps(widget).columns;
  if (Array.isArray(declared)) {
    const picked = declared.filter((entry): entry is string => typeof entry === "string");
    if (picked.length > 0) {
      return picked;
    }
  }
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}

function rowLimit(widget: WorkspaceWidget): number {
  const raw = widgetProps(widget).limit;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.trunc(raw), 100)
    : DEFAULT_ROW_LIMIT;
}

export function mapTable(widget: WorkspaceWidget, value: unknown): TableModel {
  const all = resolveRows(widget, value);
  const limit = rowLimit(widget);
  const rows = all.slice(0, limit);
  return { columns: resolveColumns(widget, rows), rows, shown: rows.length, total: all.length };
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function renderTable(widget: WorkspaceWidget, value: unknown): TemplateResult {
  const model = mapTable(widget, value);
  if (model.total === 0 || model.columns.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.table.empty")}
    </div>`;
  }
  const remaining = model.total - model.shown;
  return html`
    <div class="workspace-table">
      <table class="workspace-table__grid">
        <thead>
          <tr>
            ${model.columns.map((column) => html`<th scope="col">${column}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${model.rows.map(
            (row) => html`
              <tr>
                ${model.columns.map((column) => html`<td>${renderCell(row[column])}</td>`)}
              </tr>
            `,
          )}
        </tbody>
      </table>
      ${remaining > 0
        ? html`<div class="workspace-table__footer">
            ${t("workspaces.widget.table.more", { count: String(remaining) })}
          </div>`
        : nothing}
    </div>
  `;
}
