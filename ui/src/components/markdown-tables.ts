import { render } from "lit";
import type MarkdownIt from "markdown-it";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { icons } from "./icons.ts";
import { toolIcons } from "./icons-tools.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";
import { escapeMarkdownHtml } from "./markdown-text.ts";

const tableShellSelector = ".chat-text .markdown-table[data-table-interactions]";
const tableViewportSelector = ".markdown-table__viewport";
const enhancedTableShells = new WeakSet<HTMLElement>();
const tableOwnerStates = new WeakMap<HTMLElement, TableOwnerState>();
const tableCopyResetTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

type TableOwnerState = {
  mutationObserver: MutationObserver;
  resizeObserver: ResizeObserver | null;
  observedViewports: Set<HTMLElement>;
};

export function installMarkdownTables(markdownParser: MarkdownIt): void {
  const defaultTableOpen = markdownParser.renderer.rules.table_open;
  const defaultTableClose = markdownParser.renderer.rules.table_close;
  markdownParser.renderer.rules.table_open = (tokens, index, options, env, renderer) => {
    if ((env as Partial<MarkdownRenderEnv>).tableInteractions !== "enabled") {
      return defaultTableOpen?.(tokens, index, options, env, renderer) ?? "<table>\n";
    }
    return '<div class="markdown-table" data-table-interactions><div class="markdown-table__viewport"><table>';
  };
  markdownParser.renderer.rules.table_close = (tokens, index, options, env, renderer) => {
    if ((env as Partial<MarkdownRenderEnv>).tableInteractions !== "enabled") {
      return defaultTableClose?.(tokens, index, options, env, renderer) ?? "</table>\n";
    }
    return `</table></div><div class="markdown-table__actions"><button type="button" class="markdown-table__expand" aria-label="${escapeMarkdownHtml(t("common.expandTable"))}"></button><button type="button" class="markdown-table__copy" aria-label="${escapeMarkdownHtml(t("common.copyTable"))}"></button></div></div>`;
  };
}

function tableText(table: HTMLTableElement): string {
  return [...table.rows]
    .map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? "").join("\t"))
    .join("\n");
}

function syncTableOverflow(shell: HTMLElement): void {
  const viewport = shell.querySelector<HTMLElement>(tableViewportSelector);
  if (!viewport) {
    return;
  }
  const overflows = viewport.scrollWidth - viewport.clientWidth > 1;
  shell.classList.toggle("markdown-table--can-scroll-left", overflows && viewport.scrollLeft > 1);
  shell.classList.toggle(
    "markdown-table--can-scroll-right",
    overflows && viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1,
  );
}

function enhanceTableShell(shell: HTMLElement, resizeObserver?: ResizeObserver | null): void {
  if (enhancedTableShells.has(shell)) {
    syncTableOverflow(shell);
    return;
  }
  const viewport = shell.querySelector<HTMLElement>(tableViewportSelector);
  const expand = shell.querySelector<HTMLElement>(".markdown-table__expand");
  const copy = shell.querySelector<HTMLElement>(".markdown-table__copy");
  if (!viewport || !expand || !copy) {
    return;
  }
  enhancedTableShells.add(shell);
  render(toolIcons.maximize, expand);
  render(icons.copy, copy);
  viewport.addEventListener("scroll", () => syncTableOverflow(shell), { passive: true });
  resizeObserver?.observe(viewport);
  syncTableOverflow(shell);
}

export function enhanceMarkdownTables(owner: HTMLElement): void {
  let state = tableOwnerStates.get(owner);
  if (!state) {
    const observedViewports = new Set<HTMLElement>();
    const resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((entries) => {
            for (const entry of entries) {
              const shell = entry.target.closest<HTMLElement>(tableShellSelector);
              if (shell) {
                syncTableOverflow(shell);
              }
            }
          })
        : null;
    const syncOwnerTables = () => {
      for (const viewport of observedViewports) {
        if (!viewport.isConnected || !owner.contains(viewport)) {
          resizeObserver?.unobserve(viewport);
          observedViewports.delete(viewport);
        }
      }
      for (const shell of owner.querySelectorAll<HTMLElement>(tableShellSelector)) {
        const viewport = shell.querySelector<HTMLElement>(tableViewportSelector);
        enhanceTableShell(shell, resizeObserver);
        if (viewport) {
          observedViewports.add(viewport);
        }
      }
    };
    const mutationObserver = new MutationObserver(syncOwnerTables);
    mutationObserver.observe(owner, { childList: true, subtree: true });
    state = { mutationObserver, resizeObserver, observedViewports };
    tableOwnerStates.set(owner, state);
  }
  for (const shell of owner.querySelectorAll<HTMLElement>(tableShellSelector)) {
    const viewport = shell.querySelector<HTMLElement>(tableViewportSelector);
    enhanceTableShell(shell, state.resizeObserver);
    if (viewport) {
      state.observedViewports.add(viewport);
    }
  }
}

function showTableDialog(table: HTMLTableElement, trigger: HTMLElement): void {
  const dialog = document.createElement("dialog");
  dialog.className = "markdown-table-dialog chat-text";
  dialog.setAttribute("aria-label", t("common.expandedTable"));

  const close = document.createElement("button");
  close.type = "button";
  close.className = "markdown-table-dialog__close";
  close.setAttribute("aria-label", t("common.closeTable"));
  render(icons.x, close);

  const expandedTable = table.cloneNode(true);
  dialog.append(close, expandedTable);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (trigger.isConnected) {
      trigger.focus({ preventScroll: true });
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus({ preventScroll: true });
}

export function handleMarkdownTableInteraction(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const shell = target.closest<HTMLElement>(tableShellSelector);
  if (!shell) {
    return;
  }
  enhanceTableShell(shell);
  const table = shell.querySelector<HTMLTableElement>("table");
  if (!table) {
    return;
  }
  const expand = target.closest<HTMLElement>(".markdown-table__expand");
  if (expand) {
    showTableDialog(table, expand);
    return;
  }
  const copy = target.closest<HTMLElement>(".markdown-table__copy");
  if (copy) {
    void copyToClipboard(tableText(table)).then((copied) => {
      copy.setAttribute("aria-label", t(copied ? "common.copied" : "common.copyFailed"));
      clearTimeout(tableCopyResetTimers.get(copy));
      const resetTimer = setTimeout(() => {
        copy.setAttribute("aria-label", t("common.copyTable"));
        tableCopyResetTimers.delete(copy);
      }, copied ? 1500 : 2000);
      tableCopyResetTimers.set(copy, resetTimer);
    });
  }
}
