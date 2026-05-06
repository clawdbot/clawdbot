import path from "node:path";
import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault, type CompileMemoryWikiResult } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiSegment,
  normalizeSourceIds,
  normalizeWikiClaims,
  type WikiClaim,
} from "./markdown.js";
import {
  readQueryableWikiPages,
  resolveQueryableWikiPageByLookup,
  type QueryableWikiPage,
} from "./query.js";
import { initializeMemoryWikiVault } from "./vault.js";

const GENERATED_START = "<!-- openclaw:wiki:generated:start -->";
const GENERATED_END = "<!-- openclaw:wiki:generated:end -->";
const HUMAN_START = "<!-- openclaw:human:start -->";
const HUMAN_END = "<!-- openclaw:human:end -->";

type CreateSynthesisMemoryWikiMutation = {
  op: "create_synthesis";
  title: string;
  body: string;
  sourceIds: string[];
  claims?: WikiClaim[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number;
  status?: string;
};

type UpdateMetadataMemoryWikiMutation = {
  op: "update_metadata";
  lookup: string;
  sourceIds?: string[];
  claims?: WikiClaim[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number | null;
  status?: string;
};

export type ApplyMemoryWikiMutation =
  | CreateSynthesisMemoryWikiMutation
  | UpdateMetadataMemoryWikiMutation;

type ApplyMemoryWikiMutationResult = {
  changed: boolean;
  operation: ApplyMemoryWikiMutation["op"];
  pagePath: string;
  pageId?: string;
  compile: CompileMemoryWikiResult;
};

export function normalizeMemoryWikiMutationInput(rawParams: unknown): ApplyMemoryWikiMutation {
  const params = rawParams as {
    op: ApplyMemoryWikiMutation["op"];
    title?: string;
    body?: string;
    lookup?: string;
    sourceIds?: string[];
    claims?: WikiClaim[];
    contradictions?: string[];
    questions?: string[];
    confidence?: number | null;
    status?: string;
  };
  if (params.op === "create_synthesis") {
    if (!params.title?.trim()) {
      throw new Error("wiki mutation requires title for create_synthesis.");
    }
    if (!params.body?.trim()) {
      throw new Error("wiki mutation requires body for create_synthesis.");
    }
    if (!params.sourceIds || params.sourceIds.length === 0) {
      throw new Error("wiki mutation requires at least one sourceId for create_synthesis.");
    }
    return {
      op: "create_synthesis",
      title: params.title,
      body: params.body,
      sourceIds: params.sourceIds,
      ...(Array.isArray(params.claims) ? { claims: normalizeWikiClaims(params.claims) } : {}),
      ...(params.contradictions ? { contradictions: params.contradictions } : {}),
      ...(params.questions ? { questions: params.questions } : {}),
      ...(typeof params.confidence === "number" ? { confidence: params.confidence } : {}),
      ...(params.status ? { status: params.status } : {}),
    };
  }
  if (!params.lookup?.trim()) {
    throw new Error("wiki mutation requires lookup for update_metadata.");
  }
  return {
    op: "update_metadata",
    lookup: params.lookup,
    ...(params.sourceIds ? { sourceIds: params.sourceIds } : {}),
    ...(Array.isArray(params.claims) ? { claims: normalizeWikiClaims(params.claims) } : {}),
    ...(params.contradictions ? { contradictions: params.contradictions } : {}),
    ...(params.questions ? { questions: params.questions } : {}),
    ...(params.confidence !== undefined ? { confidence: params.confidence } : {}),
    ...(params.status ? { status: params.status } : {}),
  };
}

function normalizeUniqueStrings(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
  return normalized;
}

function ensureHumanNotesBlock(body: string): string {
  if (body.includes(HUMAN_START) && body.includes(HUMAN_END)) {
    return body;
  }
  const trimmed = body.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}## Notes\n${HUMAN_START}\n${HUMAN_END}\n`;
}

function buildSynthesisBody(params: {
  title: string;
  originalBody?: string;
  generatedBody: string;
}): string {
  const base = params.originalBody?.trim().length
    ? params.originalBody
    : `# ${params.title}\n\n## Notes\n${HUMAN_START}\n${HUMAN_END}\n`;
  const withGenerated = replaceManagedMarkdownBlock({
    original: base,
    heading: "## Summary",
    startMarker: GENERATED_START,
    endMarker: GENERATED_END,
    body: params.generatedBody,
  });
  return ensureHumanNotesBlock(withGenerated);
}

async function writeWikiPage(params: {
  rootDir: string;
  relativePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}): Promise<boolean> {
  const root = await fsRoot(params.rootDir);
  const rendered = withTrailingNewline(
    renderWikiMarkdown({
      frontmatter: params.frontmatter,
      body: params.body,
    }),
  );
  const existing = await root.readText(params.relativePath).catch(() => "");
  if (existing === rendered) {
    return false;
  }
  await root.write(params.relativePath, rendered);
  return true;
}

async function resolveWritablePage(params: {
  config: ResolvedMemoryWikiConfig;
  lookup: string;
}): Promise<QueryableWikiPage | null> {
  const pages = await readQueryableWikiPages(params.config.vault.path);
  return resolveQueryableWikiPageByLookup(pages, params.lookup);
}

async function applyCreateSynthesisMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: CreateSynthesisMemoryWikiMutation;
}): Promise<{ changed: boolean; pagePath: string; pageId: string }> {
  const slug = slugifyWikiSegment(params.mutation.title);
  const pagePath = path.join("syntheses", `${slug}.md`).replace(/\\/g, "/");
  const root = await fsRoot(params.config.vault.path);
  const existing = await root.readText(pagePath).catch(() => "");
  const parsed = parseWikiMarkdown(existing);
  const pageId =
    (typeof parsed.frontmatter.id === "string" && parsed.frontmatter.id.trim()) ||
    `synthesis.${slug}`;
  const changed = await writeWikiPage({
    rootDir: params.config.vault.path,
    relativePath: pagePath,
    frontmatter: {
      ...parsed.frontmatter,
      pageType: "synthesis",
      id: pageId,
      title: params.mutation.title,
      sourceIds: normalizeSourceIds(params.mutation.sourceIds),
      ...(params.mutation.claims ? { claims: normalizeWikiClaims(params.mutation.claims) } : {}),
      ...(normalizeUniqueStrings(params.mutation.contradictions)
        ? { contradictions: normalizeUniqueStrings(params.mutation.contradictions) }
        : {}),
      ...(normalizeUniqueStrings(params.mutation.questions)
        ? { questions: normalizeUniqueStrings(params.mutation.questions) }
        : {}),
      ...(typeof params.mutation.confidence === "number"
        ? { confidence: params.mutation.confidence }
        : {}),
      status: params.mutation.status?.trim() || "active",
      updatedAt: new Date().toISOString(),
    },
    body: buildSynthesisBody({
      title: params.mutation.title,
      originalBody: parsed.body,
      generatedBody: params.mutation.body.trim(),
    }),
  });
  return { changed, pagePath, pageId };
}

function buildUpdatedFrontmatter(params: {
  original: Record<string, unknown>;
  mutation: UpdateMetadataMemoryWikiMutation;
}): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    ...params.original,
    updatedAt: new Date().toISOString(),
  };
  if (params.mutation.sourceIds) {
    frontmatter.sourceIds = normalizeSourceIds(params.mutation.sourceIds);
  }
  if (params.mutation.claims) {
    const claims = normalizeWikiClaims(params.mutation.claims);
    if (claims.length > 0) {
      frontmatter.claims = claims;
    } else {
      delete frontmatter.claims;
    }
  }
  if (params.mutation.contradictions) {
    const contradictions = normalizeUniqueStrings(params.mutation.contradictions) ?? [];
    if (contradictions.length > 0) {
      frontmatter.contradictions = contradictions;
    } else {
      delete frontmatter.contradictions;
    }
  }
  if (params.mutation.questions) {
    const questions = normalizeUniqueStrings(params.mutation.questions) ?? [];
    if (questions.length > 0) {
      frontmatter.questions = questions;
    } else {
      delete frontmatter.questions;
    }
  }
  if (params.mutation.confidence === null) {
    delete frontmatter.confidence;
  } else if (typeof params.mutation.confidence === "number") {
    frontmatter.confidence = params.mutation.confidence;
  }
  if (params.mutation.status?.trim()) {
    frontmatter.status = params.mutation.status.trim();
  }
  return frontmatter;
}

async function applyUpdateMetadataMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: UpdateMetadataMemoryWikiMutation;
}): Promise<{ changed: boolean; pagePath: string; pageId?: string }> {
  const page = await resolveWritablePage({
    config: params.config,
    lookup: params.mutation.lookup,
  });
  if (!page) {
    throw new Error(`Wiki page not found: ${params.mutation.lookup}`);
  }
  const parsed = parseWikiMarkdown(page.raw);
  const changed = await writeWikiPage({
    rootDir: params.config.vault.path,
    relativePath: page.relativePath,
    frontmatter: buildUpdatedFrontmatter({
      original: parsed.frontmatter,
      mutation: params.mutation,
    }),
    body: parsed.body,
  });
  return {
    changed,
    pagePath: page.relativePath,
    ...(page.id ? { pageId: page.id } : {}),
  };
}

export async function applyMemoryWikiMutation(params: {
  config: ResolvedMemoryWikiConfig;
  mutation: ApplyMemoryWikiMutation;
}): Promise<ApplyMemoryWikiMutationResult> {
  await initializeMemoryWikiVault(params.config);
  const result =
    params.mutation.op === "create_synthesis"
      ? await applyCreateSynthesisMutation({
          config: params.config,
          mutation: params.mutation,
        })
      : await applyUpdateMetadataMutation({
          config: params.config,
          mutation: params.mutation,
        });
  const compile = await compileMemoryWikiVault(params.config);
  return {
    changed: result.changed,
    operation: params.mutation.op,
    pagePath: result.pagePath,
    ...(result.pageId ? { pageId: result.pageId } : {}),
    compile,
  };
}
