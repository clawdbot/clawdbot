import {
  type Component,
  getEditorKeybindings,
  Input,
  isKeyRelease,
  matchesKey,
  type SelectItem,
  type SelectListTheme,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import { visibleWidth } from "../../terminal/ansi.js";
import { findWordBoundaryIndex, fuzzyFilterLower, prepareSearchItems } from "./fuzzy-filter.js";

export interface SearchableSelectListTheme extends SelectListTheme {
  searchPrompt: (text: string) => string;
  searchInput: (text: string) => string;
  matchHighlight: (text: string) => string;
}

/**
 * A select list with a search input at the top for fuzzy filtering.
 */
export class SearchableSelectList implements Component {
  private items: SelectItem[];
  private filteredItems: SelectItem[];
  private selectedIndex = 0;
  private maxVisible: number;
  private theme: SearchableSelectListTheme;
  private searchInput: Input;
  private regexCache = new Map<string, RegExp>();

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onSelectionChange?: (item: SelectItem) => void;

  constructor(items: SelectItem[], maxVisible: number, theme: SearchableSelectListTheme) {
    this.items = items;
    this.filteredItems = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.searchInput = new Input();
  }

  private getCachedRegex(pattern: string): RegExp {
    let regex = this.regexCache.get(pattern);
    if (!regex) {
      regex = new RegExp(this.escapeRegex(pattern), "gi");
      this.regexCache.set(pattern, regex);
    }
    return regex;
  }

  private updateFilter() {
    const query = this.searchInput.getValue().trim();

    if (!query) {
      this.filteredItems = this.items;
    } else {
      this.filteredItems = this.smartFilter(query);
    }

    // Reset selection when filter changes
    this.selectedIndex = 0;
    this.notifySelectionChange();
  }

  /**
   * Smart filtering that prioritizes:
   * 1. Exact substring match in label (highest priority)
   * 2. Word-boundary prefix match in label
   * 3. Exact substring in description
   * 4. Fuzzy match (lowest priority)
   */
  private smartFilter(query: string): SelectItem[] {
    const q = query.toLowerCase();
    type ScoredItem = { item: SelectItem; tier: number; score: number };
    const scoredItems: ScoredItem[] = [];
    const fuzzyCandidates: SelectItem[] = [];

    for (const item of this.items) {
      const label = item.label.toLowerCase();
      const desc = (item.description ?? "").toLowerCase();

      // Tier 1: Exact substring in label
      const labelIndex = label.indexOf(q);
      if (labelIndex !== -1) {
        scoredItems.push({ item, tier: 0, score: labelIndex });
        continue;
      }
      // Tier 2: Word-boundary prefix in label
      const wordBoundaryIndex = findWordBoundaryIndex(label, q);
      if (wordBoundaryIndex !== null) {
        scoredItems.push({ item, tier: 1, score: wordBoundaryIndex });
        continue;
      }
      // Tier 3: Exact substring in description
      const descIndex = desc.indexOf(q);
      if (descIndex !== -1) {
        scoredItems.push({ item, tier: 2, score: descIndex });
        continue;
      }
      // Tier 4: Fuzzy match (score 300+)
      fuzzyCandidates.push(item);
    }

    scoredItems.sort(this.compareByScore);

    const preparedCandidates = prepareSearchItems(fuzzyCandidates);
    const fuzzyMatches = fuzzyFilterLower(preparedCandidates, q);

    return [...scoredItems.map((s) => s.item), ...fuzzyMatches];
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private compareByScore = (
    a: { item: SelectItem; tier: number; score: number },
    b: { item: SelectItem; tier: number; score: number },
  ) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.score !== b.score) return a.score - b.score;
    return this.getItemLabel(a.item).localeCompare(this.getItemLabel(b.item));
  };

  private getItemLabel(item: SelectItem): string {
    return item.label || item.value;
  }

  private highlightMatch(text: string, query: string): string {
    const tokens = query
      .trim()
      .split(/\s+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return text;

    const uniqueTokens = Array.from(new Set(tokens)).sort((a, b) => b.length - a.length);
    let result = text;
    for (const token of uniqueTokens) {
      const regex = this.getCachedRegex(token);
      result = result.replace(regex, (match) => this.theme.matchHighlight(match));
    }
    return result;
  }

  setSelectedIndex(index: number) {
    this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
  }

  invalidate() {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];

    // Search input line
    const promptText = "search: ";
    const prompt = this.theme.searchPrompt(promptText);
    const inputWidth = Math.max(1, width - visibleWidth(prompt));
    const inputLines = this.searchInput.render(inputWidth);
    const inputText = inputLines[0] ?? "";
    lines.push(`${prompt}${this.theme.searchInput(inputText)}`);
    lines.push(""); // Spacer

    const query = this.searchInput.getValue().trim();

    // If no items match filter, show message
    if (this.filteredItems.length === 0) {
      lines.push(this.theme.noMatch("  No matches"));
      return lines;
    }

    // Calculate visible range with scrolling
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.filteredItems.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

    // Render visible items
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;
      const isSelected = i === this.selectedIndex;
      lines.push(this.renderItemLine(item, isSelected, width, query));
    }

    // Show scroll indicator if needed
    if (this.filteredItems.length > this.maxVisible) {
      const scrollInfo = `${this.selectedIndex + 1}/${this.filteredItems.length}`;
      lines.push(this.theme.scrollInfo(`  ${scrollInfo}`));
    }

    return lines;
  }

  private renderItemLine(
    item: SelectItem,
    isSelected: boolean,
    width: number,
    query: string,
  ): string {
    const prefix = isSelected ? "→ " : "  ";
    const prefixWidth = prefix.length;
    const displayValue = this.getItemLabel(item);

    if (item.description && width > 40) {
      const maxValueWidth = Math.min(30, width - prefixWidth - 4);
      const truncatedValue = truncateToWidth(displayValue, maxValueWidth, "");
      const valueText = this.highlightMatch(truncatedValue, query);
      const spacingWidth = Math.max(1, 32 - visibleWidth(valueText));
      const spacing = " ".repeat(spacingWidth);
      const descriptionStart = prefixWidth + visibleWidth(valueText) + spacing.length;
      const remainingWidth = width - descriptionStart - 2;
      if (remainingWidth > 10) {
        const truncatedDesc = truncateToWidth(item.description, remainingWidth, "");
        const descText = isSelected
          ? this.highlightMatch(truncatedDesc, query)
          : this.highlightMatch(this.theme.description(truncatedDesc), query);
        const line = `${prefix}${valueText}${spacing}${descText}`;
        return isSelected ? this.theme.selectedText(line) : line;
      }
    }

    const maxWidth = width - prefixWidth - 2;
    const truncatedValue = truncateToWidth(displayValue, maxWidth, "");
    const valueText = this.highlightMatch(truncatedValue, query);
    const line = `${prefix}${valueText}`;
    return isSelected ? this.theme.selectedText(line) : line;
  }

  handleInput(keyData: string): void {
    if (isKeyRelease(keyData)) return;

    const allowVimNav = !this.searchInput.getValue().trim();

    // Navigation keys
    if (
      matchesKey(keyData, "up") ||
      matchesKey(keyData, "ctrl+p") ||
      (allowVimNav && keyData === "k")
    ) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.notifySelectionChange();
      return;
    }

    if (
      matchesKey(keyData, "down") ||
      matchesKey(keyData, "ctrl+n") ||
      (allowVimNav && keyData === "j")
    ) {
      this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
      this.notifySelectionChange();
      return;
    }

    if (matchesKey(keyData, "enter")) {
      const item = this.filteredItems[this.selectedIndex];
      if (item && this.onSelect) {
        this.onSelect(item);
      }
      return;
    }

    const kb = getEditorKeybindings();
    if (kb.matches(keyData, "selectCancel")) {
      if (this.onCancel) {
        this.onCancel();
      }
      return;
    }

    // Pass other keys to search input
    const prevValue = this.searchInput.getValue();
    this.searchInput.handleInput(keyData);
    const newValue = this.searchInput.getValue();

    if (prevValue !== newValue) {
      this.updateFilter();
    }
  }

  private notifySelectionChange() {
    const item = this.filteredItems[this.selectedIndex];
    if (item && this.onSelectionChange) {
      this.onSelectionChange(item);
    }
  }

  getSelectedItem(): SelectItem | null {
    return this.filteredItems[this.selectedIndex] ?? null;
  }
}
