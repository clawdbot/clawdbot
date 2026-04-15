/**
 * Shared ARIA role classification sets used by both the Playwright and Chrome MCP
 * snapshot paths. Keep these in sync — divergence causes the two drivers to produce
 * different snapshot output for the same page.
 */

/** Roles that represent user-interactive elements and always get a ref. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** Roles that carry meaningful content and get a ref when named. */
export const CONTENT_ROLES = new Set([
  "article",
  "cell",
  "columnheader",
  "gridcell",
  "heading",
  "listitem",
  "main",
  "navigation",
  "region",
  "rowheader",
]);

/** Structural/container roles — typically skipped in compact mode. */
export const STRUCTURAL_ROLES = new Set([
  "application",
  "directory",
  "document",
  "generic",
  "grid",
  "group",
  "ignored",
  "list",
  "menu",
  "menubar",
  "none",
  "presentation",
  "row",
  "rowgroup",
  "table",
  "tablist",
  "toolbar",
  "tree",
  "treegrid",
]);
