// Firecrawl plugin module implements firecrawl scrape tool behavior.
import { optionalStringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { Type } from "typebox";
import { runFirecrawlScrape } from "./firecrawl-client.js";

const FirecrawlScrapeToolSchema = Type.Object(
  {
    url: Type.String({ description: "HTTP or HTTPS URL to scrape via Firecrawl." }),
    extractMode: optionalStringEnum(["markdown", "text"] as const, {
      description: 'Extraction mode ("markdown" or "text"). Default: markdown.',
    }),
    maxChars: Type.Optional(
      Type.Integer({
        description: "Maximum characters to return.",
        minimum: 100,
      }),
    ),
    onlyMainContent: Type.Optional(
      Type.Boolean({
        description: "Keep only main content when Firecrawl supports it.",
      }),
    ),
    maxAgeMs: Type.Optional(
      Type.Integer({
        description: "Maximum Firecrawl cache age in milliseconds.",
        minimum: 0,
      }),
    ),
    proxy: optionalStringEnum(["auto", "basic", "stealth"] as const, {
      description: 'Firecrawl proxy mode ("auto", "basic", or "stealth").',
    }),
    storeInCache: Type.Optional(
      Type.Boolean({
        description: "Whether Firecrawl should store the scrape in its cache.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description: "Timeout in seconds for the Firecrawl scrape request.",
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createFirecrawlScrapeTool(api: OpenClawPluginApi) {
  return {
    name: "firecrawl_scrape",
    label: "Firecrawl Scrape",
    description:
      "Scrape a page using Firecrawl v2/scrape. Useful for JS-heavy or bot-protected pages where plain web_fetch is weak.",
    parameters: FirecrawlScrapeToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const url = readStringParam(rawParams, "url", { required: true });
      const extractMode =
        readStringParam(rawParams, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readPositiveIntegerParam(rawParams, "maxChars");
      const maxAgeMs = readNonNegativeIntegerParam(rawParams, "maxAgeMs");
      const timeoutSeconds = readPositiveIntegerParam(rawParams, "timeoutSeconds");
      const proxyRaw = readStringParam(rawParams, "proxy");
      const proxy =
        proxyRaw === "basic" || proxyRaw === "stealth" || proxyRaw === "auto"
          ? proxyRaw
          : undefined;
      const onlyMainContent =
        typeof rawParams.onlyMainContent === "boolean" ? rawParams.onlyMainContent : undefined;
      const storeInCache =
        typeof rawParams.storeInCache === "boolean" ? rawParams.storeInCache : undefined;

      return jsonResult(
        await runFirecrawlScrape({
          cfg: api.config,
          url,
          extractMode,
          maxChars,
          onlyMainContent,
          maxAgeMs,
          proxy,
          storeInCache,
          timeoutSeconds,
        }),
      );
    },
  };
}
