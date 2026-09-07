// Filterable select list tests cover keyboard filtering and cursor behavior.
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
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

    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(`>Filter: <> ${query}`);
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

  it.each([
    { name: "Escape", key: "\x1b" },
    { name: "Ctrl+C", key: "\u0003" },
    { name: "Kitty Ctrl+C", key: "\x1b[99;5u" },
    { name: "modifyOtherKeys Ctrl+C", key: "\x1b[27;5;99~" },
  ])("clears the active filter before cancelling with $name", ({ key }) => {
    const list = new FilterableSelectList(testItems, 5, mockTheme);
    let cancelled = false;
    list.onCancel = () => {
      cancelled = true;
    };

    typeInput(list, "beta");
    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(">Filter: <> beta");
    expect(list.getSelectedItem()?.value).toBe("session-2");

    list.handleInput(key);

    expect(cancelled).toBe(false);
    expect(stripAnsi(list.render(80)[0] ?? "").trimEnd()).toBe(">Filter: <>");
    expect(list.getSelectedItem()?.value).toBe("session-1");
    expect(list.render(80).join("\n")).toContain("first session");
    expect(list.render(80).join("\n")).toContain("second session");
    list.handleInput(key);
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

  it("sanitizes rendered fields without changing filtering or the selected value", () => {
    const attacks = [
      "\u001b[38;5;201m",
      "\u001b[3J",
      "\u001b]0;filter-title\u0007",
      "\u001b]52;c;filter-clipboard\u0007",
      "\u009b2K",
      "\u009d0;filter-c1-title\u009c",
    ];
    const rawValue = `fv-start${attacks[1]}fv-end\r\nمرحبا\tשלום`;
    const description = `fd-start${attacks[3]}fd-end\n東京`;
    const list = new FilterableSelectList(
      [
        { value: "decoy", label: "decoy" },
        {
          value: rawValue,
          label: attacks.join(""),
          description,
          searchText: "raw-filter-target",
        },
      ],
      5,
      mockTheme,
    );
    let selectedValue: string | undefined;
    list.onSelect = (item) => {
      selectedValue = item.value;
    };

    typeInput(list, "raw-filter-target");
    const rendered = list.render(160).join("\n");

    expect(rendered).toContain("fv-startfv-end");
    expect(rendered).toContain("مرحبا שלום");
    expect(rendered).toContain("fd-startfd-end 東京");
    expect(rendered).toContain("\u2067");
    expect(rendered).toContain("\u2069");
    for (const attack of attacks) {
      expect(rendered).not.toContain(attack);
    }
    expect(rendered).not.toContain("fv-end\r\nمرحبا\tשלום");

    // Text removed from display remains part of the original search fields.
    list.handleInput("\x1b");
    typeInput(list, "filter-title");
    expect(list.getSelectedItem()).toMatchObject({ searchText: "raw-filter-target" });
    list.handleInput("\r");
    expect(selectedValue).toBe(rawValue);
  });

  it("reads changed row fields when the picker is reopened", () => {
    const item = { value: "session", label: "Before", searchText: "old-name" };
    const first = new FilterableSelectList([item], 5, mockTheme);
    typeInput(first, "old-name");
    expect(first.getSelectedItem()?.value).toBe("session");

    item.label = "After";
    item.searchText = "new-name";
    const reopened = new FilterableSelectList([item], 5, mockTheme);
    typeInput(reopened, "new-name");

    expect(reopened.getSelectedItem()).toMatchObject(item);
    expect(reopened.render(80).join("\n")).toContain("After");
  });
});
