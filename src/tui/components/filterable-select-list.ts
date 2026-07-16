// Filterable select list component supports filtered keyboard selection.
import type { Component } from "@earendil-works/pi-tui";
import {
  fuzzyFilter,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";

export interface FilterableSelectItem extends SelectItem {
  /** Additional searchable fields beyond label */
  searchText?: string;
}

interface FilterableSelectListTheme extends SelectListTheme {
  filterLabel: (text: string) => string;
}

/**
 * Combines text input filtering with a select list.
 * User types to filter, arrows/j/k to navigate, Enter to select, Escape to clear/cancel.
 */
export class FilterableSelectList implements Component {
  private input: Input;
  private selectList: SelectList;
  private allItems: FilterableSelectItem[];
  private maxVisible: number;
  private theme: FilterableSelectListTheme;
  private filterText = "";

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;

  constructor(items: FilterableSelectItem[], maxVisible: number, theme: FilterableSelectListTheme) {
    this.allItems = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.input = new Input();
    this.selectList = new SelectList(this.allItems, maxVisible, theme);
  }

  private applyFilter(): void {
    if (!this.filterText.trim()) {
      this.selectList = new SelectList(this.allItems, this.maxVisible, this.theme);
      return;
    }
    const filtered = fuzzyFilter(this.allItems, this.filterText, (item) =>
      [item.label, item.description, item.searchText].filter(Boolean).join(" "),
    );
    this.selectList = new SelectList(filtered, this.maxVisible, this.theme);
  }

  invalidate(): void {
    this.input.invalidate();
    this.selectList.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Filter input row
    const filterLabel = this.theme.filterLabel("Filter: ");
    const inputLines = this.input.render(width - 8);
    const inputText = inputLines[0] ?? "";
    lines.push(filterLabel + inputText);

    // Separator
    lines.push(chalk.dim("─".repeat(Math.max(0, width))));

    // Select list
    const listLines = this.selectList.render(width);
    lines.push(...listLines);

    return lines;
  }

  handleInput(keyData: string): void {
    const allowVimNav = !this.filterText.trim();

    // Navigation: arrows, vim j/k, or ctrl+p/ctrl+n
    if (
      matchesKey(keyData, "up") ||
      matchesKey(keyData, "ctrl+p") ||
      (allowVimNav && keyData === "k")
    ) {
      this.selectList.handleInput("\x1b[A");
      return;
    }

    if (
      matchesKey(keyData, "down") ||
      matchesKey(keyData, "ctrl+n") ||
      (allowVimNav && keyData === "j")
    ) {
      this.selectList.handleInput("\x1b[B");
      return;
    }

    // Enter selects
    if (matchesKey(keyData, "enter")) {
      const selected = this.selectList.getSelectedItem();
      if (selected) {
        this.onSelect?.(selected);
      }
      return;
    }

    // Escape: clear filter or cancel
    if (matchesKey(keyData, "escape") || keyData === "\u0003") {
      if (this.filterText) {
        this.filterText = "";
        this.input.setValue("");
        this.applyFilter();
      } else {
        this.onCancel?.();
      }
      return;
    }

    // All other input goes to filter
    const prevValue = this.input.getValue();
    this.input.handleInput(keyData);
    const newValue = this.input.getValue();

    if (newValue !== prevValue) {
      this.filterText = newValue;
      this.applyFilter();
    }
  }

  getSelectedItem(): SelectItem | null {
    return this.selectList.getSelectedItem();
  }

  getFilterText(): string {
    return this.filterText;
  }
}
