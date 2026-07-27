import { describe, expect, it } from "vitest";
import {
  buildLexicalIndex,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./tool-search-ranking.js";
import { ToolSearchRuntime, toolSearchEntryText } from "./tool-search-runtime.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

function entry(partial: Partial<ToolSearchCatalogEntry>): ToolSearchCatalogEntry {
  return {
    id: partial.name ?? "id",
    source: "openclaw",
    name: "tool",
    description: "",
    tool: {} as never,
    ...partial,
  } as ToolSearchCatalogEntry;
}

const CATALOG = [
  entry({ name: "web_search", description: "Search the web for current information" }),
  entry({ name: "read_file", description: "Read a file from disk" }),
  entry({ name: "cron_create", description: "Schedule a recurring task" }),
  entry({ name: "spreadsheet_open", description: "Open a spreadsheet document" }),
  entry({
    name: "issue_create",
    description: "Open a new issue",
    parameters: {
      type: "object",
      properties: { repository: { type: "string", description: "Target repository" } },
    },
  }),
];

function runtime(): ToolSearchRuntime {
  const ctx = {
    catalogRef: { current: { entries: CATALOG, searchCount: 0, describeCount: 0, callCount: 0 } },
  };
  return new ToolSearchRuntime(ctx as never, {
    enabled: true,
    mode: "directory",
    codeTimeoutMs: 1000,
    searchDefaultLimit: 10,
    maxSearchLimit: 50,
  });
}

describe("tokenizeQuery", () => {
  it("collapses inflected forms to a shared root", () => {
    expect(tokenizeQuery("scheduling")).toEqual(tokenizeDocument("schedule"));
    expect(tokenizeQuery("reminders")).toContain("remind");
  });

  it("drops stopwords so they cannot carry a match", () => {
    expect(tokenizeQuery("the and with")).toEqual([]);
  });

  it("expands intent words toward the vocabulary descriptions use", () => {
    // "look up the price" shares no word with "Search the web", so without
    // expansion a lexical index cannot connect them at all.
    expect(tokenizeQuery("look up the price")).toContain(tokenizeDocument("search")[0]);
  });

  it("emits both the joined name and its parts", () => {
    const terms = tokenizeDocument("web_search");
    expect(terms).toContain("web_search");
    expect(terms).toContain("web");
  });
});

describe("scoreLexical", () => {
  it("returns nothing for a query with no usable terms", () => {
    const index = buildLexicalIndex([{ value: "a", terms: tokenizeDocument("search the web") }]);

    // A non-English query tokenizes to nothing. Returning the whole catalog
    // unranked would read as a ranked answer without being one.
    expect(scoreLexical(index, tokenizeQuery("価格を調べて"))).toEqual([]);
    expect(scoreLexical(index, [])).toEqual([]);
  });

  it("ranks a rare term above one shared across the catalog", () => {
    const index = buildLexicalIndex([
      { value: "rare", terms: tokenizeDocument("search quantum") },
      { value: "common-a", terms: tokenizeDocument("search files") },
      { value: "common-b", terms: tokenizeDocument("search mail") },
    ]);
    const ranked = scoreLexical(index, tokenizeQuery("quantum")).toSorted(
      (a, b) => b.score - a.score,
    );

    expect(ranked[0]?.value).toBe("rare");
  });
});

describe("toolSearchEntryText", () => {
  it("indexes first-party parameter names and descriptions", () => {
    const text = toolSearchEntryText(CATALOG[4] as ToolSearchCatalogEntry);

    expect(text).toContain("repository");
    expect(text).toContain("Target repository");
  });

  it("never traverses schemas from sources the catalog treats as untrusted", () => {
    const hostile = entry({
      source: "client",
      name: "client_pick_file",
      description: "Ask the client to pick a file",
      parameters: {
        type: "object",
        properties: new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("client properties must remain deferred");
            },
          },
        ),
      },
    });

    expect(() => toolSearchEntryText(hostile)).not.toThrow();
    expect(toolSearchEntryText(hostile)).not.toContain("pick_file_property");
  });
});

describe("ToolSearchRuntime.search", () => {
  it.each([
    {
      query: "scheduling",
      expected: "cron_create",
      why: "stemmed to the description's 'Schedule'",
    },
    { query: "reminder", expected: "cron_create", why: "expanded toward schedule/cron" },
    {
      query: "look up the price",
      expected: "web_search",
      why: "intent expanded toward search/web",
    },
    { query: "repository", expected: "issue_create", why: "matched only via a parameter" },
  ])("finds $expected for $query ($why)", async ({ query, expected }) => {
    const hits = await runtime().search(query);
    expect(hits.map((hit) => hit.name)).toContain(expected);
  });

  it("does not match a term that only appears inside another word", async () => {
    // "spreadsheet" contains "read"; substring scoring used to rank it here.
    const names = (await runtime().search("read")).map((hit) => hit.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("spreadsheet_open");
  });

  it("returns nothing rather than an unranked catalog for a non-English query", async () => {
    expect(await runtime().search("価格を調べて")).toEqual([]);
  });
});
