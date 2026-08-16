// Searchable select list tests cover filtering and selection behavior.
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { SearchableSelectList, type SearchableSelectListTheme } from "./searchable-select-list.js";

const mockTheme: SearchableSelectListTheme = {
  selectedPrefix: (t) => `[${t}]`,
  selectedText: (t) => `**${t}**`,
  description: (t) => `(${t})`,
  scrollInfo: (t) => `~${t}~`,
  noMatch: (t) => `!${t}!`,
  searchPrompt: (t) => `>${t}<`,
  searchInput: (t) => `|${t}|`,
  matchHighlight: (t) => `*${t}*`,
};

const ansiHighlightTheme: SearchableSelectListTheme = {
  selectedPrefix: (t) => t,
  selectedText: (t) => t,
  description: (t) => t,
  scrollInfo: (t) => t,
  noMatch: (t) => t,
  searchPrompt: (t) => t,
  searchInput: (t) => t,
  matchHighlight: (t) => `\u001b[31m${t}\u001b[0m`,
};

const testItems = [
  {
    value: "anthropic/claude-3-opus",
    label: "anthropic/claude-3-opus",
    description: "Claude 3 Opus",
  },
  {
    value: "anthropic/claude-3-sonnet",
    label: "anthropic/claude-3-sonnet",
    description: "Claude 3 Sonnet",
  },
  { value: "openai/gpt-4", label: "openai/gpt-4", description: "GPT-4" },
  { value: "openai/gpt-4-turbo", label: "openai/gpt-4-turbo", description: "GPT-4 Turbo" },
  { value: "google/gemini-pro", label: "google/gemini-pro", description: "Gemini Pro" },
];

describe("SearchableSelectList", () => {
  function typeInput(list: SearchableSelectList, text: string) {
    for (const ch of text) {
      list.handleInput(ch);
    }
  }

  function expectSelectedValueForQuery(
    list: SearchableSelectList,
    query: string,
    expectedValue: string,
  ) {
    typeInput(list, query);
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe(expectedValue);
  }

  function expectNoMatchesForQuery(list: SearchableSelectList, query: string) {
    typeInput(list, query);
    const output = list.render(80);
    expect(output.join("\n")).toContain("No matches");
  }

  function expectDescriptionVisibilityAtWidth(width: number, shouldContainDescription: boolean) {
    const items = [
      { value: "one", label: "one", description: "desc" },
      { value: "two", label: "two", description: "desc" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);
    // Ensure first row is non-selected so description styling path is exercised.
    list.setSelectedIndex(1);
    const output = list.render(width).join("\n");
    if (shouldContainDescription) {
      expect(output).toContain("(desc)");
    } else {
      expect(output).not.toContain("(desc)");
    }
  }

  it("renders all items when no filter is applied", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    const output = list.render(80);

    // Should have search prompt line, spacer, and items
    expect(output.length).toBeGreaterThanOrEqual(3);
    expect(output[0]).toContain("search");
  });

  it("emits the hardware cursor marker only while the search input is focused", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

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
      const items = [
        {
          value: "cjk",
          label: "\u001b[32m日本語の検索結果\u001b[0m",
          description: "長い説明と表示幅の検証",
        },
        { value: "other", label: "another long search result" },
      ];
      const list = new SearchableSelectList(items, 1, ansiHighlightTheme);
      list.focused = true;

      for (const line of list.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }

      list.handleInput("missing");
      for (const line of list.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    },
  );

  it("does not truncate long labels on wide terminals when description is present", () => {
    const tail = "__TAIL__";
    const longLabel = `session-${"x".repeat(40)}${tail}`; // > 30 chars; tail would be lost before PR
    const items = [{ value: longLabel, label: longLabel, description: "desc" }];
    const list = new SearchableSelectList(items, 5, mockTheme);

    const output = list.render(120).join("\n");
    expect(output).toContain(tail);
  });

  it("does not show description layout at width 40 (boundary)", () => {
    expectDescriptionVisibilityAtWidth(40, false);
  });

  it("shows description layout at width 41 (boundary)", () => {
    expectDescriptionVisibilityAtWidth(41, true);
  });

  it("keeps ANSI-highlighted description rows within terminal width", () => {
    const label = `provider/${"x".repeat(80)}`;
    const items = [
      { value: label, label, description: "Some description text that should not overflow" },
      { value: "other", label: "other", description: "Other description" },
    ];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);
    list.setSelectedIndex(1); // make first row non-selected so description styling is applied

    typeInput(list, "provider");

    const width = 80;
    const output = list.render(width);
    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps model-search rows within width when filtering by m", () => {
    const items = [
      { value: "minimax-cn/MiniMax-M2", label: "minimax-cn/MiniMax-M2", description: "MiniMax M2" },
      {
        value: "minimax-cn/MiniMax-M2.1",
        label: "minimax-cn/MiniMax-M2.1",
        description: "MiniMax M2.1",
      },
      {
        value: "mistral/codestral-latest",
        label: "mistral/codestral-latest",
        description: "Codestral",
      },
      {
        value: "mistral/devstral-medium-latest",
        label: "mistral/devstral-medium-latest",
        description: "Devstral Medium",
      },
    ];
    const list = new SearchableSelectList(items, 9, ansiHighlightTheme);
    typeInput(list, "m");

    const width = 209;
    for (const line of list.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("ignores ANSI escape codes in search matching", () => {
    const items = [
      { value: "styled", label: "\u001b[32mopenai/gpt-4\u001b[0m", description: "Styled label" },
      { value: "plain", label: "plain-item", description: "Plain label" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectNoMatchesForQuery(list, "32m");
  });

  it("does not corrupt ANSI sequences when highlighting multiple tokens", () => {
    const items = [{ value: "gpt-model", label: "gpt-model" }];
    const list = new SearchableSelectList(items, 5, ansiHighlightTheme);

    typeInput(list, "gpt m");

    const renderedLine = list.render(80).find((line) => stripAnsi(line).includes("gpt-model"));
    if (!renderedLine) {
      throw new Error("expected rendered gpt-model line");
    }
    const highlightOpens = renderedLine.split("\u001b[31m").length - 1;
    expect(highlightOpens).toBe(2);
  });

  it("filters items when typing", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Simulate typing "gemini" - unique enough to narrow down
    typeInput(list, "gemini");

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("google/gemini-pro");
  });

  it("prioritizes exact substring matches over fuzzy matches", () => {
    // Add items where one has early exact match, others are fuzzy or late matches
    const items = [
      { value: "openrouter/auto", label: "openrouter/auto", description: "Routes to best" },
      { value: "opus-direct", label: "opus-direct", description: "Direct opus model" },
      {
        value: "anthropic/claude-3-opus",
        label: "anthropic/claude-3-opus",
        description: "Claude 3 Opus",
      },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    // Type "opus" - should match "opus-direct" first (earliest exact substring)
    typeInput(list, "opus");

    // First result should be "opus-direct" where "opus" appears at position 0
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("opus-direct");
  });

  it("keeps exact label matches ahead of description matches", () => {
    const longPrefix = "x".repeat(250);
    const items = [
      { value: "late-label", label: `${longPrefix}opus`, description: "late exact match" },
      { value: "desc-first", label: "provider/other", description: "opus in description" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectSelectedValueForQuery(list, "opus", "late-label");
  });

  it("exact label match beats description match", () => {
    const items = [
      {
        value: "provider/other",
        label: "provider/other",
        description: "This mentions opus in description",
      },
      { value: "provider/opus-model", label: "provider/opus-model", description: "Something else" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    typeInput(list, "opus");

    // Label match should win over description match
    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("provider/opus-model");
  });

  it("orders description matches by earliest index", () => {
    const items = [
      { value: "first", label: "first", description: "prefix opus value" },
      { value: "second", label: "second", description: "opus suffix value" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    expectSelectedValueForQuery(list, "opus", "second");
  });

  it("filters items with fuzzy matching", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Simulate typing "gpt" which should match openai/gpt-4 models
    typeInput(list, "gpt");

    const selected = list.getSelectedItem();
    expect(selected?.value).toContain("gpt");
  });

  it("treats slashes as fuzzy token separators", () => {
    const list = new SearchableSelectList(
      [{ value: "sonnet", label: "Claude Sonnet", description: "anthropic" }],
      5,
      mockTheme,
    );

    expectSelectedValueForQuery(list, "anthropic/sonnet", "sonnet");
  });

  it("preserves fuzzy ranking when only fuzzy matches exist", () => {
    const items = [
      { value: "xg---4", label: "xg---4", description: "Worse fuzzy match" },
      { value: "gpt-4", label: "gpt-4", description: "Better fuzzy match" },
    ];
    const list = new SearchableSelectList(items, 5, mockTheme);

    typeInput(list, "g4");

    const selected = list.getSelectedItem();
    expect(selected?.value).toBe("gpt-4");
  });

  it("highlights matches in rendered output", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    typeInput(list, "gpt");

    const output = list.render(80).join("\n");
    expect(output).toContain("*gpt*");
  });

  it("discards compiled regexes from previous searches", () => {
    const queryLength = 300;
    const label = "a".repeat(queryLength);
    const list = new SearchableSelectList([{ value: "match", label }], 5, mockTheme);

    for (let index = 0; index < queryLength; index += 1) {
      list.handleInput("a");
      list.render(queryLength + 10);
    }

    const regexCache = (list as unknown as { regexCache: Map<string, RegExp> }).regexCache;
    expect(regexCache.size).toBe(1);
    expect(regexCache.has(label)).toBe(true);
    expect(list.render(queryLength + 10).join("\n")).toContain(`*${label}*`);
  });

  it("shows no match message when filter yields no results", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    expectNoMatchesForQuery(list, "xyz");
  });

  it("navigates with arrow keys", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);

    // Initially first item is selected
    expect(list.getSelectedItem()?.value).toBe("anthropic/claude-3-opus");

    // Press down arrow (escape sequence for down arrow)
    list.handleInput("\x1b[B");

    expect(list.getSelectedItem()?.value).toBe("anthropic/claude-3-sonnet");
  });

  it.each([
    { query: "j", expectedValue: "juliet" },
    { query: "k", expectedValue: "kilo" },
  ])("filters names beginning with $query", ({ query, expectedValue }) => {
    const list = new SearchableSelectList(
      [
        { value: "alpha", label: "alpha" },
        { value: "kilo", label: "kilo" },
        { value: "juliet", label: "juliet" },
      ],
      5,
      mockTheme,
    );

    list.handleInput(query);

    expect(list.getSelectedItem()?.value).toBe(expectedValue);
    expect(stripAnsi(list.render(80)[0] ?? "")).toContain(query);
  });

  it("calls onSelect when enter is pressed", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let selectedValue: string | undefined;

    list.onSelect = (item) => {
      selectedValue = item.value;
    };

    // Press enter
    list.handleInput("\r");

    expect(selectedValue).toBe("anthropic/claude-3-opus");
  });

  it("sanitizes rendered fields before applying trusted highlighting", () => {
    const attacks = [
      "\u001b[38;5;201m",
      "\u001b[3J",
      "\u001b]0;search-title\u0007",
      "\u001b]52;c;search-clipboard\u0007",
      "\u009b2K",
      "\u009d0;search-c1-title\u009c",
    ];
    const rawValue = `selector-value-start${attacks[1]}selector-value-end\r\nمرحبا\tשלום`;
    const description = `selector-description-start${attacks[3]}selector-description-end\n東京`;
    const list = new SearchableSelectList(
      [
        {
          value: rawValue,
          label: attacks.join(""),
          description,
          searchText: "selector-target",
        },
      ],
      5,
      ansiHighlightTheme,
    );
    let selectedValue: string | undefined;
    list.onSelect = (item) => {
      selectedValue = item.value;
    };

    typeInput(list, "selector");
    const rendered = list.render(160).join("\n");
    const plainRendered = stripAnsi(rendered);

    expect(rendered).toContain("\u001b[31mselector\u001b[0m-value-start");
    expect(plainRendered).toContain("selector-description-startselector-description-end 東京");
    expect(plainRendered).toContain("مرحبا שלום");
    expect(plainRendered).toContain("\u2067");
    expect(plainRendered).toContain("\u2069");
    for (const attack of attacks) {
      expect(rendered).not.toContain(attack);
    }
    expect(rendered).not.toContain("selector-value-end\r\nمرحبا\tשלום");

    list.handleInput("\r");
    expect(selectedValue).toBe(rawValue);
  });

  it("calls onCancel when escape is pressed", () => {
    const list = new SearchableSelectList(testItems, 5, mockTheme);
    let cancelled = false;

    list.onCancel = () => {
      cancelled = true;
    };

    // Press escape
    list.handleInput("\x1b");

    expect(cancelled).toBe(true);
  });
});
