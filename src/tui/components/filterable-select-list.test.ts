// Filterable select list tests cover keyboard filtering and cursor behavior.
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
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

  it("emits the hardware cursor marker only while the filter input is focused", () => {
    const list = new FilterableSelectList(testItems, 5, mockTheme);

    expect(list.focused).toBe(false);
    expect(list.render(80)[0]).not.toContain(CURSOR_MARKER);

    list.focused = true;
    expect(list.focused).toBe(true);
    expect(list.render(80)[0]).toContain(CURSOR_MARKER);

    list.focused = false;
    expect(list.focused).toBe(false);
    expect(list.render(80)[0]).not.toContain(CURSOR_MARKER);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
    "keeps ANSI, CJK, scroll, and no-match rows within %i terminal columns",
    (width) => {
      const items: FilterableSelectItem[] = [
        {
          value: "cjk",
          label: "\u001b[32m日本語の検索結果\u001b[0m",
          description: "長い説明と表示幅の検証",
        },
        { value: "other", label: "another long search result" },
      ];
      const list = new FilterableSelectList(items, 1, mockTheme);
      list.focused = true;

      for (const line of list.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }

      typeInput(list, "missing");
      for (const line of list.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  it.each([
    { query: "j", expectedValue: "juliet" },
    { query: "k", expectedValue: "kilo" },
  ])("filters names beginning with $query", ({ query, expectedValue }) => {
    const list = new FilterableSelectList(
      [
        { value: "alpha", label: "alpha" },
        { value: "kilo", label: "kilo" },
        { value: "juliet", label: "juliet" },
      ],
      5,
      mockTheme,
    );

    list.handleInput(query);

    expect(list.getFilterText()).toBe(query);
    expect(list.getSelectedItem()?.value).toBe(expectedValue);
  });

  it("preserves arrow and Ctrl-key navigation", () => {
    const list = new FilterableSelectList(testItems, 5, mockTheme);

    list.handleInput("\x1b[B");
    expect(list.getSelectedItem()?.value).toBe("session-2");

    list.handleInput("\u0010");
    expect(list.getSelectedItem()?.value).toBe("session-1");

    list.handleInput("\u000e");
    expect(list.getSelectedItem()?.value).toBe("session-2");

    list.handleInput("\x1b[A");
    expect(list.getSelectedItem()?.value).toBe("session-1");
  });

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
