// Filterable select list tests cover keyboard filtering and cursor behavior.
import { describe, expect, it } from "vitest";
import { FilterableSelectList, type FilterableSelectItem } from "./filterable-select-list.js";

type FilterableSelectListTheme = ConstructorParameters<typeof FilterableSelectList>[2];

const mockTheme: FilterableSelectListTheme = {
  selectedPrefix: (t) => `[${t}]`,
  selectedText: (t) => `**${t}**`,
  description: (t) => `(${t})`,
  scrollInfo: (t) => `~${t}~`,
  noMatch: (t) => `!${t}!`,
  filterLabel: (t) => `>${t}<`,
};

const testItems: FilterableSelectItem[] = [
  {
    value: "session-1",
    label: "first session",
    description: "Oldest",
    searchText: "alpha",
  },
  {
    value: "session-2",
    label: "second session",
    description: "Newest",
    searchText: "beta",
  },
];

describe("FilterableSelectList", () => {
  function typeInput(list: FilterableSelectList, text: string) {
    for (const ch of text) {
      list.handleInput(ch);
    }
  }

  it("clears the active filter before cancelling", () => {
    const list = new FilterableSelectList(testItems, 5, mockTheme);
    let cancelled = false;
    list.onCancel = () => {
      cancelled = true;
    };

    typeInput(list, "beta");
    expect(list.getFilterText()).toBe("beta");
    expect(list.getSelectedItem()?.value).toBe("session-2");

    list.handleInput("\x1b");

    expect(cancelled).toBe(false);
    expect(list.getFilterText()).toBe("");
    expect(list.render(80).join("\n")).toContain("first session");
    expect(list.render(80).join("\n")).toContain("second session");
  });

  it("calls onCancel when escape is pressed with an empty filter", () => {
    const list = new FilterableSelectList(testItems, 5, mockTheme);
    let cancelled = false;
    list.onCancel = () => {
      cancelled = true;
    };

    list.handleInput("\x1b");

    expect(cancelled).toBe(true);
  });

  it("calls onCancel when ctrl+c is pressed with an empty filter", () => {
    const list = new FilterableSelectList(testItems, 5, mockTheme);
    let cancelled = false;
    list.onCancel = () => {
      cancelled = true;
    };

    list.handleInput("\u0003");

    expect(cancelled).toBe(true);
  });

  it("uses native alpha-numeric fuzzy matching", () => {
    const list = new FilterableSelectList(
      [{ value: "codex", label: "gpt-5.2-codex" }],
      5,
      mockTheme,
    );

    typeInput(list, "codex52");

    expect(list.getSelectedItem()?.value).toBe("codex");
  });
});
