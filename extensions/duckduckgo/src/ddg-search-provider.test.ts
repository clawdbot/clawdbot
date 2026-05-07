import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDuckDuckGoWebSearchProvider as createDuckDuckGoWebSearchContractProvider } from "../web-search-contract-api.js";
import { DEFAULT_DDG_SAFE_SEARCH, resolveDdgRegion, resolveDdgSafeSearch } from "./config.js";

const { runDuckDuckGoSearch } = vi.hoisted(() => ({
  runDuckDuckGoSearch: vi.fn(async (params: Record<string, unknown>) => params),
}));

vi.mock("./ddg-client.js", () => ({
  runDuckDuckGoSearch,
}));

describe("duckduckgo web search provider", () => {
  let createDuckDuckGoWebSearchProvider: typeof import("./ddg-search-provider.js").createDuckDuckGoWebSearchProvider;
  let ddgClientTesting: typeof import("./ddg-client.js").__testing;

  afterAll(() => {
    vi.doUnmock("./ddg-client.js");
    vi.resetModules();
  });

  beforeAll(async () => {
    ({ createDuckDuckGoWebSearchProvider } = await import("./ddg-search-provider.js"));
    ({ __testing: ddgClientTesting } =
      await vi.importActual<typeof import("./ddg-client.js")>("./ddg-client.js"));
    await import("../index.js");
  });

  beforeEach(() => {
    runDuckDuckGoSearch.mockReset();
    runDuckDuckGoSearch.mockImplementation(async (params: Record<string, unknown>) => params);
  });

  it("exposes keyless metadata and enables the plugin in config", () => {
    const provider = createDuckDuckGoWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }
    const applied = provider.applySelectionConfig({});

    expect(provider.id).toBe("duckduckgo");
    expect(provider.label).toBe("DuckDuckGo Search (experimental)");
    expect(provider.onboardingScopes).toEqual(["text-inference"]);
    expect(createDuckDuckGoWebSearchContractProvider().onboardingScopes).toEqual([
      "text-inference",
    ]);
    expect(provider.requiresCredential).toBe(false);
    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.duckduckgo?.enabled).toBe(true);
  });

  it("maps generic tool arguments into DuckDuckGo search params", async () => {
    const provider = createDuckDuckGoWebSearchProvider();
    const tool = provider.createTool({
      config: { test: true },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }

    const result = await tool.execute({
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });

    expect(runDuckDuckGoSearch).toHaveBeenCalledWith({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
    expect(result).toEqual({
      config: { test: true },
      query: "openclaw docs",
      count: 4,
      region: "us-en",
      safeSearch: "off",
    });
  });

  it("reads region from plugin config and normalizes empty values away", () => {
    expect(
      resolveDdgRegion({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  region: "de-de",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("de-de");

    expect(
      resolveDdgRegion({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  region: "   ",
                },
              },
            },
          },
        },
      } as never),
    ).toBeUndefined();
  });

  it("defaults safeSearch to moderate and accepts strict and off", () => {
    expect(resolveDdgSafeSearch(undefined)).toBe(DEFAULT_DDG_SAFE_SEARCH);

    expect(
      resolveDdgSafeSearch({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  safeSearch: "strict",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("strict");

    expect(
      resolveDdgSafeSearch({
        plugins: {
          entries: {
            duckduckgo: {
              config: {
                webSearch: {
                  safeSearch: "off",
                },
              },
            },
          },
        },
      } as never),
    ).toBe("off");
  });

  it("decodes direct and redirect urls plus common html entities", () => {
    expect(
      ddgClientTesting.decodeDuckDuckGoUrl(
        "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsearch%3Fq%3Dclaw",
      ),
    ).toBe("https://example.com/search?q=claw");
    expect(ddgClientTesting.decodeDuckDuckGoUrl("https://example.com")).toBe("https://example.com");
    expect(ddgClientTesting.decodeHtmlEntities("Fish &amp; Chips&nbsp;&hellip; &#39;ok&#39;")).toBe(
      "Fish & Chips ... 'ok'",
    );
  });

  it("parses results when href appears before class", () => {
    const html = `
      <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com" class="result__a">
        Example &amp; Co
      </a>
      <a class="result__snippet">Fast&nbsp;search &hellip; with details</a>
      <a class="result__a" href="https://example.org/direct">Direct result</a>
      <a class="result__snippet">Second snippet</a>
    `;

    expect(ddgClientTesting.parseDuckDuckGoHtml(html)).toEqual([
      {
        title: "Example & Co",
        url: "https://example.com",
        snippet: "Fast search ... with details",
      },
      {
        title: "Direct result",
        url: "https://example.org/direct",
        snippet: "Second snippet",
      },
    ]);
  });

  it("detects bot challenge pages without flagging ordinary result snippets", () => {
    const challengeHtml = `
      <html>
        <body>
          <form>
            <h1>Are you a human?</h1>
            <div class="g-recaptcha">captcha</div>
          </form>
        </body>
      </html>
    `;
    const normalHtml = `
      <a class="result__a" href="https://example.com/challenge">Coding Challenge</a>
      <a class="result__snippet">A fun coding challenge for interview prep.</a>
    `;

    expect(ddgClientTesting.isBotChallenge(challengeHtml)).toBe(true);
    expect(ddgClientTesting.parseDuckDuckGoHtml(challengeHtml)).toEqual([]);
    expect(ddgClientTesting.isBotChallenge(normalHtml)).toBe(false);
    expect(ddgClientTesting.parseDuckDuckGoHtml(normalHtml)).toEqual([
      {
        title: "Coding Challenge",
        url: "https://example.com/challenge",
        snippet: "A fun coding challenge for interview prep.",
      },
    ]);
  });
});
