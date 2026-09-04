import { describe, expect, it } from "vitest";
import {
  buildLexicalIndex,
  scoreLexical,
  tokenizeDocument,
  tokenizeQuery,
} from "./tool-search-ranking.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
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
    catalogRef: {
      current: {
        entries: CATALOG,
        counterScope: "scope-1",
        searchCount: 0,
        describeCount: 0,
        callCount: 0,
      },
    },
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
    expect(tokenizeQuery("scheduling").map((term) => term.term)).toEqual(
      tokenizeDocument("schedule"),
    );
    expect(tokenizeQuery("reminders").map((term) => term.term)).toContain("remind");
  });

  it.each([
    ["running", "run"],
    ["stopping", "stop"],
    ["logging", "log"],
    ["planning", "plan"],
    ["runner", "run"],
  ])("undoes the consonant English doubles before a suffix: %s", (inflected, root) => {
    // Without undoubling, "running" stems to "runn" and can never meet "run".
    expect(tokenizeDocument(inflected)).toEqual(tokenizeDocument(root));
  });

  it.each(["call", "process", "off"])("keeps doubles that belong to the root: %s", (word) => {
    expect(tokenizeDocument(`${word}ing`)).toEqual(tokenizeDocument(word));
  });

  it("fires expansions for -ies plurals of a trigger word", () => {
    // "directories" must reach the directory/folder group, not stall at
    // "directorie" and expand nothing.
    expect(tokenizeQuery("list directories").map((term) => term.term)).toContain(
      tokenizeDocument("file")[0],
    );
  });

  it("keeps capability verbs that name real operations", () => {
    // "get" looks like filler but names operations ("get_weather"); dropping it
    // would reduce "get issue" to "issue" and let delete/update entries win.
    expect(tokenizeQuery("get").map((term) => term.term)).not.toEqual([]);
  });

  it("drops stopwords so they cannot carry a match", () => {
    expect(tokenizeQuery("the and with")).toEqual([]);
  });

  it("expands intent words toward the vocabulary descriptions use", () => {
    // "look up the price" shares no word with "Search the web", so without
    // expansion a lexical index cannot connect them at all.
    const terms = tokenizeQuery("look up the price");
    const search = terms.find((term) => term.term === tokenizeDocument("search")[0]);

    expect(search).toBeDefined();
    // Discounted: an expansion is a guess about wording, not something typed.
    expect(search?.weight).toBeLessThan(1);
    expect(terms.find((term) => term.term === tokenizeDocument("price")[0])?.weight).toBe(1);
  });

  it("emits both the joined name and its parts", () => {
    const terms = tokenizeDocument("web_search");
    expect(terms).toContain("web_search");
    expect(terms).toContain("web");
  });

  it("decomposes camelCase names, which MCP catalogs commonly use", () => {
    const document = tokenizeDocument("readFile");

    // Lowercasing first would leave only "readfil", which "read file" cannot meet.
    for (const term of tokenizeQuery("read file")) {
      expect(document).toContain(term.term);
    }
  });

  it.each(["news", "status", "canvas", "alias"])(
    "keeps %s distinct from the word left by stripping its s",
    (word) => {
      // "news" -> "new" would literal-match every "Create a new ..." tool, and
      // literal matches are ranked ahead of the web tool the query meant.
      expect(tokenizeDocument(word)).toEqual([word]);
    },
  );

  it("does not let a singular/plural collision invent an intent", () => {
    // "news" must not normalize to "new", or "open a new issue" acquires a
    // web-search intent it never asked for.
    expect(tokenizeQuery("open a new issue").map((term) => term.term)).not.toContain(
      tokenizeDocument("search")[0],
    );
  });
});

describe("scoreLexical", () => {
  it("includes empty documents in length normalization without creating search hits", () => {
    const value = { id: "match" };
    const index = buildLexicalIndex([
      { value, terms: ["needle", "needle"] },
      { value: { id: "empty" }, terms: [] },
    ]);

    expect(index.documentCount).toBe(2);
    expect(index.averageLength).toBe(1);
    const hits = scoreLexical(index, [{ term: "needle", weight: 1 }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe(value);
    expect(hits[0]?.matchedLiteral).toBe(true);
    expect(hits[0]?.score).toBeCloseTo((Math.log(2) * 2 * 2.2) / (2 + 1.2 * 1.75));
  });

  it("returns nothing for a query with no usable terms", () => {
    const index = buildLexicalIndex([{ value: "a", terms: tokenizeDocument("search the web") }]);

    // Returning the whole catalog unranked would read as a ranked answer
    // without being one, which is what the previous scorer did here.
    expect(scoreLexical(index, tokenizeQuery("the and with"))).toEqual([]);
    expect(scoreLexical(index, [])).toEqual([]);
  });

  it("indexes non-Latin text rather than discarding it", () => {
    // The English-query instruction is guidance for the model, not a filter: a
    // catalog may legitimately describe a tool in another script, and dropping
    // those terms would make it permanently unreachable.
    const index = buildLexicalIndex([{ value: "jp", terms: tokenizeDocument("価格 lookup") }]);

    expect(scoreLexical(index, tokenizeQuery("価格")).map((hit) => hit.value)).toEqual(["jp"]);
  });

  it("marks literal overlap so callers can rank it ahead of expansion-only hits", () => {
    // A common literal term carries little IDF, so a short document collecting
    // two rare expansions can outscore it. The tier, not the weight, is what
    // keeps a tool matching the typed word from being dropped by the limit.
    const index = buildLexicalIndex([
      { value: "weather-a", terms: tokenizeDocument("weather_now Report the weather") },
      { value: "weather-b", terms: tokenizeDocument("weather_hourly Hourly weather") },
      { value: "weather-c", terms: tokenizeDocument("weather_alerts Weather alerts") },
      { value: "web", terms: tokenizeDocument("web_search Search the web") },
    ]);

    const hits = scoreLexical(index, tokenizeQuery("weather"));
    const web = hits.find((hit) => hit.value === "web");

    expect(hits.filter((hit) => hit.matchedLiteral).map((hit) => hit.value)).toContain("weather-a");
    expect(web?.matchedLiteral).toBe(false);
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

describe("untrusted schemas", () => {
  it("never traverses parameters from a source the catalog treats as untrusted", async () => {
    // compactToolSearchCatalogEntry already reports non-first-party parameters
    // as "unknown"; indexing must respect the same boundary. A client can hand
    // us a lazy object that throws on property access, and MCP-authored text
    // must not become ranking input.
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
    const ctx = {
      catalogRef: {
        current: {
          entries: [...CATALOG, hostile],
          counterScope: "scope-1",
          searchCount: 0,
          describeCount: 0,
          callCount: 0,
        },
      },
    };
    const search = new ToolSearchRuntime(ctx as never, {
      enabled: true,
      mode: "directory",
      codeTimeoutMs: 1000,
      searchDefaultLimit: 10,
      maxSearchLimit: 50,
    });

    // Reaching the schema at all throws, so surviving the query is the proof.
    await expect(search.search("pick a file")).resolves.toBeDefined();
    expect((await search.search("client_pick_file")).map((hit) => hit.name)).toContain(
      "client_pick_file",
    );
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

  it("ranks an exact tool name first even when a shorter entry mentions it", async () => {
    const catalog = [
      entry({ name: "issue_create", description: "Open a new issue" }),
      entry({ id: "b", name: "notes", description: "Notes about issue_create and other tools" }),
    ];
    const ctx = {
      catalogRef: {
        current: {
          entries: catalog,
          counterScope: "scope-1",
          searchCount: 0,
          describeCount: 0,
          callCount: 0,
        },
      },
    };
    const search = new ToolSearchRuntime(ctx as never, {
      enabled: true,
      mode: "directory",
      codeTimeoutMs: 1000,
      searchDefaultLimit: 10,
      maxSearchLimit: 50,
    });

    // Querying a known name is a request for that tool, not a description of one.
    const hits = await search.search("issue_create");
    expect(hits[0]?.name).toBe("issue_create");
  });

  it.each([
    ["cookies", "cookie"],
    ["policies", "policy"],
    ["movies", "movie"],
    ["repositories", "repository"],
    ["queries", "query"],
    ["memories", "memory"],
  ])("matches both readings of an -ies plural: %s", (plural, singular) => {
    // "policies" is "policy" but "cookies" is "cookie"; one rule cannot serve
    // both, so both stems are emitted and whichever the catalog uses matches.
    const plurals = new Set(tokenizeDocument(plural));
    expect(tokenizeDocument(singular).some((term) => plurals.has(term))).toBe(true);
  });

  it.each([
    ["getURLs", "url"],
    ["getOAuthToken", "auth"],
    ["readFile", "read"],
  ])("keeps acronym and camelCase parts addressable: %s", (name, part) => {
    // Splitting on case transitions alone cuts "URLs" into "UR"/"Ls".
    expect(tokenizeDocument(name)).toContain(part);
  });

  it("returns a tool named exactly like a stopword", async () => {
    const catalog = [
      entry({ id: "z-local", name: "do", description: "Run a stored action" }),
      entry({ id: "a-remote", source: "mcp", name: "DO", description: "Run a remote action" }),
      entry({ id: "m-local", name: "do", description: "Run another stored action" }),
      entry({ id: "other", name: "other", description: "Unrelated" }),
    ];
    const ctx = {
      catalogRef: {
        current: {
          entries: catalog,
          counterScope: "scope-1",
          searchCount: 0,
          describeCount: 0,
          callCount: 0,
        },
      },
    };
    const search = new ToolSearchRuntime(ctx as never, {
      enabled: true,
      mode: "directory",
      codeTimeoutMs: 1000,
      searchDefaultLimit: 10,
      maxSearchLimit: 50,
    });

    // "do" tokenizes to nothing; exact matches still retain catalog order,
    // with visibility applied before the result limit.
    expect((await search.search(" DO ")).map((hit) => hit.id)).toEqual([
      "z-local",
      "a-remote",
      "m-local",
    ]);
    expect((await search.search("do", { limit: 2 })).map((hit) => hit.id)).toEqual([
      "z-local",
      "a-remote",
    ]);
    expect(
      (await search.search("do", { includeMcp: false, limit: 1 })).map((hit) => hit.id),
    ).toEqual(["z-local"]);
    expect(
      (
        await search.search("do", {
          allowedIds: new Set(["a-remote", "m-local"]),
          includeMcp: false,
          limit: 1,
        })
      ).map((hit) => hit.id),
    ).toEqual(["m-local"]);
  });

  it("does not match a term that only appears inside another word", async () => {
    // "spreadsheet" contains "read"; substring scoring used to rank it here.
    const names = (await runtime().search("read")).map((hit) => hit.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("spreadsheet_open");
  });

  it("returns nothing rather than an unranked catalog for a query the catalog cannot answer", async () => {
    // The catalog is described in English, so this matches nothing. The old
    // scorer returned every tool in id order for exactly this input.
    expect(await runtime().search("価格を調べて")).toEqual([]);
  });
});
