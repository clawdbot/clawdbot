import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { runTavilyExtract } from "./tavily-client.js";
import { optionalStringEnum } from "./tavily-tool-schema.js";

const TavilyExtractToolSchema = Type.Object(
  {
    urls: Type.Array(Type.String(), {
      description: "One or more URLs to extract content from (max 20).",
      minItems: 1,
      maxItems: 20,
    }),
    query: Type.Optional(
      Type.String({
        description: "Rerank extracted chunks by relevance to this query.",
      }),
    ),
    extract_depth: optionalStringEnum(["basic", "advanced"] as const, {
      description: '"basic" (default) or "advanced" (for JS-heavy pages).',
    }),
    chunks_per_source: Type.Optional(
      Type.Number({
        description: "Chunks per URL (1-5, requires query).",
        minimum: 1,
        maximum: 5,
      }),
    ),
    include_images: Type.Optional(
      Type.Boolean({
        description: "Include image URLs in extraction results.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function createTavilyExtractTool(api: OpenClawPluginApi) {
  return {
    name: "tavily_extract",
    label: "Tavily Extract",
    description:
      "Extract clean content from one or more URLs using Tavily. Handles JS-rendered pages. Supports query-focused chunking.",
    parameters: TavilyExtractToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const urls = Array.isArray(rawParams.urls)
        ? (rawParams.urls as string[]).filter(Boolean)
        : [];
      if (urls.length === 0) {
        throw new Error("tavily_extract requires at least one URL.");
      }
      const query = readStringParam(rawParams, "query") || undefined;
      const extractDepth = readStringParam(rawParams, "extract_depth") || undefined;
      const chunksPerSource = readNumberParam(rawParams, "chunks_per_source", {
        integer: true,
      });
      if (chunksPerSource !== undefined && !query) {
        throw new Error("tavily_extract requires query when chunks_per_source is set.");
      }
      const includeImages = rawParams.include_images === true;

      return jsonResult(
        await runTavilyExtract({
          cfg: api.config,
          urls,
          query,
          extractDepth,
          chunksPerSource,
          includeImages,
        }),
      );
    },
  };
}
