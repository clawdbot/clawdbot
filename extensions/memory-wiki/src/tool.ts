import { Type } from "typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import {
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { getMemoryWikiPage, searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

const WikiStatusSchema = Type.Object({}, { additionalProperties: false });
const WikiLintSchema = Type.Object({}, { additionalProperties: false });
const WikiSearchBackendSchema = Type.Union(
  WIKI_SEARCH_BACKENDS.map((value) => Type.Literal(value)),
);
const WikiSearchCorpusSchema = Type.Union(WIKI_SEARCH_CORPORA.map((value) => Type.Literal(value)));
const WikiSearchSchema = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    maxResults: Type.Optional(Type.Number({ minimum: 1 })),
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
  },
  { additionalProperties: false },
);
const WikiGetSchema = Type.Object(
  {
    lookup: Type.String({ minLength: 1 }),
    fromLine: Type.Optional(Type.Number({ minimum: 1 })),
    lineCount: Type.Optional(Type.Number({ minimum: 1 })),
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
  },
  { additionalProperties: false },
);
const WikiClaimEvidenceSchema = Type.Object(
  {
    sourceId: Type.Optional(Type.String({ minLength: 1 })),
    path: Type.Optional(Type.String({ minLength: 1 })),
    lines: Type.Optional(Type.String({ minLength: 1 })),
    weight: Type.Optional(Type.Number({ minimum: 0 })),
    note: Type.Optional(Type.String({ minLength: 1 })),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiClaimSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1 })),
    text: Type.String({ minLength: 1 }),
    status: Type.Optional(Type.String({ minLength: 1 })),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    evidence: Type.Optional(Type.Array(WikiClaimEvidenceSchema)),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiApplySchema = Type.Object(
  {
    op: Type.Union([Type.Literal("create_synthesis"), Type.Literal("update_metadata")]),
    title: Type.Optional(Type.String({ minLength: 1 })),
    body: Type.Optional(Type.String({ minLength: 1 })),
    lookup: Type.Optional(Type.String({ minLength: 1 })),
    sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    claims: Type.Optional(Type.Array(WikiClaimSchema)),
    contradictions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    confidence: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    status: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

async function syncImportedSourcesIfNeeded(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  await syncMemoryWikiImportedSources({ config, appConfig });
}

type WikiToolMemoryContext = {
  agentId?: string;
  agentSessionKey?: string;
};

export function createWikiStatusTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_status",
    label: "Wiki Status",
    description:
      "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.",
    parameters: WikiStatusSchema,
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      const status = await resolveMemoryWikiStatus(config, {
        appConfig,
      });
      return {
        content: [{ type: "text", text: renderMemoryWikiStatus(status) }],
        details: status,
      };
    },
  };
}

export function createWikiSearchTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_search",
    label: "Wiki Search",
    description:
      "Search wiki pages and, when shared search is enabled, the active memory corpus by title, path, id, or body text.",
    parameters: WikiSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        query: string;
        maxResults?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
      };
      await syncImportedSourcesIfNeeded(config, appConfig);
      const results = await searchMemoryWiki({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        query: params.query,
        maxResults: params.maxResults,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
      });
      const text =
        results.length === 0
          ? "No wiki or memory results."
          : results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}\nSnippet: ${result.snippet}`,
              )
              .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    },
  };
}

export function createWikiLintTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Lint the wiki vault and surface structural issues, provenance gaps, contradictions, and open questions.",
    parameters: WikiLintSchema,
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await lintMemoryWikiVault(config);
      const contradictions = result.issuesByCategory.contradictions.length;
      const openQuestions = result.issuesByCategory["open-questions"].length;
      const provenance = result.issuesByCategory.provenance.length;
      const errors = result.issues.filter((issue) => issue.severity === "error").length;
      const warnings = result.issues.filter((issue) => issue.severity === "warning").length;
      const summary =
        result.issueCount === 0
          ? "No wiki lint issues."
          : [
              `Issues: ${result.issueCount} total (${errors} errors, ${warnings} warnings)`,
              `Contradictions: ${contradictions}`,
              `Open questions: ${openQuestions}`,
              `Provenance gaps: ${provenance}`,
              `Report: ${result.reportPath}`,
            ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: result,
      };
    },
  };
}

export function createWikiApplyTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "wiki_apply",
    label: "Wiki Apply",
    description:
      "Apply narrow wiki mutations for syntheses and page metadata without freeform markdown surgery.",
    parameters: WikiApplySchema,
    execute: async (_toolCallId, rawParams) => {
      const mutation = normalizeMemoryWikiMutationInput(rawParams);
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await applyMemoryWikiMutation({ config, mutation });
      const action = result.changed ? "Updated" : "No changes for";
      const compileSummary =
        result.compile.updatedFiles.length > 0
          ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.`
          : "Indexes unchanged.";
      return {
        content: [
          {
            type: "text",
            text: `${action} ${result.pagePath} via ${result.operation}. ${compileSummary}`,
          },
        ],
        details: result,
      };
    },
  };
}

export function createWikiGetTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_get",
    label: "Wiki Get",
    description:
      "Read a wiki page by id or relative path, or fall back to the active memory corpus when shared search is enabled.",
    parameters: WikiGetSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
      };
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await getMemoryWikiPage({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        lookup: params.lookup,
        fromLine: params.fromLine,
        lineCount: params.lineCount,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
      });
      if (!result) {
        return {
          content: [{ type: "text", text: `Wiki page not found: ${params.lookup}` }],
          details: { found: false },
        };
      }
      return {
        content: [{ type: "text", text: result.content }],
        details: { found: true, ...result },
      };
    },
  };
}
