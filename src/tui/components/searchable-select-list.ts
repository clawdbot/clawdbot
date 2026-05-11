import {
  type Component,
  Input,
  isKeyRelease,
  matchesKey,
  type SelectItem,
  type SelectListTheme,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { stripAnsi, visibleWidth } from "../../terminal/ansi.js";
import { findWordBoundaryIndex, fuzzyFilterLower } from "./fuzzy-filter.js";

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_SGR_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

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

  private static readonly DESCRIPTION_LAYOUT_MIN_WIDTH = 40;
  private static readonly DESCRIPTION_MIN_WIDTH = 12;
  private static readonly DESCRIPTION_SPACING_WIDTH = 2;
  // Keep a small right margin so we don't risk wrapping due to styling/terminal quirks.
  private static readonly RIGHT_MARGIN_WIDTH = 2;

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
    const q = normalizeLowercaseStringOrEmpty(query);
    type ScoredItem = { item: SelectItem; tier: number; score: number };
    type FuzzyCandidate = { item: SelectItem; searchTextLower: string };
    const scoredItems: ScoredItem[] = [];
    const fuzzyCandidates: FuzzyCandidate[] = [];

    for (const item of this.items) {
      const rawLabel = this.getItemLabel(item);
      const rawDesc = item.description ?? "";
      const label = normalizeLowercaseStringOrEmpty(stripAnsi(rawLabel));
      const desc = normalizeLowercaseStringOrEmpty(stripAnsi(rawDesc));

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
      const searchText = (item as { searchText?: string }).searchText ?? "";
      fuzzyCandidates.push({
        item,
        searchTextLower: normalizeLowercaseStringOrEmpty(
          [rawLabel, rawDesc, searchText]
            .map((value) => stripAnsi(value))
            .filter(Boolean)
            .join(" "),
        ),
      });
    }

    scoredItems.sort(this.compareByScore);
    const fuzzyMatches = fuzzyFilterLower(fuzzyCandidates, q);
    return [...scoredItems.map((s) => s.item), ...fuzzyMatches.map((entry) => entry.item)];
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private compareByScore = (
    a: { item: SelectItem; tier: number; score: number },
    b: { item: SelectItem; tier: number; score: number },
  ) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return this.getItemLabel(a.item).localeCompare(this.getItemLabel(b.item));
  };

  private getItemLabel(item: SelectItem): string {
    return item.label || item.value;
  }

  private splitAnsiParts(text: string): Array<{ text: string; isAnsi: boolean }> {
    const parts: Array<{ text: string; isAnsi: boolean }> = [];
    ANSI_SGR_REGEX.lastIndex = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = ANSI_SGR_REGEX.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ text: text.slice(lastIndex, match.index), isAnsi: false });
      }
      parts.push({ text: match[0], isAnsi: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      parts.push({ text: text.slice(lastIndex), isAnsi: false });
    }
    return parts;
  }

  private highlightMatch(text: string, query: string): string {
    const tokens = query
      .trim()
      .split(/\s+/)
      .map((token) => normalizeLowercaseStringOrEmpty(token))
      .filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return text;
    }

    const uniqueTokens = Array.from(new Set(tokens)).toSorted((a, b) => b.length - a.length);
    let parts = this.splitAnsiParts(text);
    for (const token of uniqueTokens) {
      const regex = this.getCachedRegex(token);
      const nextParts: Array<{ text: string; isAnsi: boolean }> = [];
      for (const part of parts) {
        if (part.isAnsi) {
          nextParts.push(part);
          continue;
        }
        regex.lastIndex = 0;
        const replaced = part.text.replace(regex, (match) => this.theme.matchHighlight(match));
        if (replaced === part.text) {
          nextParts.push(part);
          continue;
        }
        nextParts.push(...this.splitAnsiParts(replaced));
      }
      parts = nextParts;
    }
    return parts.map((part) => part.text).join("");
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
      if (!item) {
        continue;
      }
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

    const description = item.description;
    if (description) {
      const descriptionLayout = this.getDescriptionLayout(width, prefixWidth);
      if (descriptionLayout) {
        const truncatedValue = truncateToWidth(displayValue, descriptionLayout.maxValueWidth, "");
        const valueText = this.highlightMatch(truncatedValue, query);

        const usedByValue = visibleWidth(valueText);
        const remainingWidth = descriptionLayout.availableWidth - usedByValue;
        const descriptionWidth = remainingWidth - descriptionLayout.spacingWidth;

        if (descriptionWidth >= SearchableSelectList.DESCRIPTION_MIN_WIDTH) {
          const spacing = " ".repeat(descriptionLayout.spacingWidth);
          const truncatedDesc = truncateToWidth(description, descriptionWidth, "");
          // Highlight plain text first, then apply theme styling to avoid corrupting ANSI codes
          const highlightedDesc = this.highlightMatch(truncatedDesc, query);
          const descText = isSelected ? highlightedDesc : this.theme.description(highlightedDesc);
          const line = `${prefix}${valueText}${spacing}${descText}`;
          return isSelected ? this.theme.selectedText(line) : line;
        }
      }
    }

    const maxWidth = width - prefixWidth - 2;
    const truncatedValue = truncateToWidth(displayValue, maxWidth, "");
    const valueText = this.highlightMatch(truncatedValue, query);
    const line = `${prefix}${valueText}`;
    return isSelected ? this.theme.selectedText(line) : line;
  }

  private getDescriptionLayout(
    width: number,
    prefixWidth: number,
  ): { availableWidth: number; maxValueWidth: number; spacingWidth: number } | null {
    if (width <= SearchableSelectList.DESCRIPTION_LAYOUT_MIN_WIDTH) {
      return null;
    }

    const availableWidth = Math.max(
      1,
      width - prefixWidth - SearchableSelectList.RIGHT_MARGIN_WIDTH,
    );
    const maxValueWidth =
      availableWidth -
      SearchableSelectList.DESCRIPTION_MIN_WIDTH -
      SearchableSelectList.DESCRIPTION_SPACING_WIDTH;

    if (maxValueWidth < 1) {
      return null;
    }

    return {
      availableWidth,
      maxValueWidth,
      spacingWidth: SearchableSelectList.DESCRIPTION_SPACING_WIDTH,
    };
  }

  handleInput(keyData: string): void {
    if (isKeyRelease(keyData)) {
      return;
    }

    // Navigation keys
    if (matchesKey(keyData, "up") || matchesKey(keyData, "ctrl+p")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.notifySelectionChange();
      return;
    }

    if (matchesKey(keyData, "down") || matchesKey(keyData, "ctrl+n")) {
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

    if (matchesKey(keyData, "escape") || keyData === "\u0003") {
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
