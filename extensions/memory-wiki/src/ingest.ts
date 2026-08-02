// Memory Wiki plugin module implements ingest behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { replaceManagedMarkdownBlock } from "openclaw/plugin-sdk/memory-host-markdown";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault } from "./compile.js";
import { invalidateMemoryWikiCompiledCache } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  parseWikiMarkdown,
  preserveHumanNotesBlock,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiPageStem,
  slugifyWikiSegment,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { resolveMemoryWikiTimestamp } from "./time.js";
import { initializeMemoryWikiVault } from "./vault.js";

type IngestMemoryWikiSourceResult = {
  sourcePath: string;
  pageId: string;
  pagePath: string;
  title: string;
  bytes: number;
  created: boolean;
  changed: boolean;
  indexUpdatedFiles: string[];
};

export type IngestMemoryWikiEvidence = {
  sourceType: string;
  type: string;
  kind: string;
  origin: string;
  directness: string;
  weight: number;
};

const EVIDENCE_FRONTMATTER_KEYS = [
  "evidenceType",
  "evidenceKind",
  "evidenceOrigin",
  "evidenceDirectness",
  "evidenceWeight",
] as const;

function preserveGeneratedRelatedBlock(rendered: string, existing: string): string {
  const start = existing.indexOf(WIKI_RELATED_START_MARKER);
  const end = existing.indexOf(WIKI_RELATED_END_MARKER, start + WIKI_RELATED_START_MARKER.length);
  if (start < 0 || end < 0) {
    return rendered;
  }
  return replaceManagedMarkdownBlock({
    original: rendered,
    heading: "## Related",
    startMarker: WIKI_RELATED_START_MARKER,
    endMarker: WIKI_RELATED_END_MARKER,
    body: existing.slice(start + WIKI_RELATED_START_MARKER.length, end).trim(),
  });
}

function resolveSourceTitle(sourcePath: string, explicitTitle?: string): string {
  if (explicitTitle?.trim()) {
    return explicitTitle.trim();
  }
  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ").trim();
}

export function assertMemoryWikiSourceBuffer(buffer: Buffer, sourcePath: string): string {
  const preview = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (preview.includes(0)) {
    throw new Error(`Cannot ingest binary file as markdown source: ${sourcePath}`);
  }
  return buffer.toString("utf8");
}

function isEmptyExistingSourcePage(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "EISDIR")
  );
}

async function readExistingSourcePage(pagePath: string): Promise<string> {
  let readError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fs.readFile(pagePath, "utf8");
    } catch (error) {
      readError = error;
    }
  }
  if (isEmptyExistingSourcePage(readError)) {
    return "";
  }
  throw readError;
}

async function ingestMemoryWikiSourceUnlocked(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  sourceBuffer?: Buffer;
  title?: string;
  nowMs?: number;
  compile?: boolean;
  dryRun?: boolean;
  initialize?: boolean;
  evidence?: IngestMemoryWikiEvidence;
}): Promise<IngestMemoryWikiSourceResult> {
  if (!params.dryRun && params.initialize !== false) {
    await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
  }
  const sourcePath = path.resolve(params.inputPath);
  const buffer = params.sourceBuffer ?? (await fs.readFile(sourcePath));
  const content = assertMemoryWikiSourceBuffer(buffer, sourcePath);
  const title = resolveSourceTitle(sourcePath, params.title);
  const slug = slugifyWikiSegment(title);
  const pageStem = slugifyWikiPageStem(title);
  const pageId = `source.${slug}`;
  const pageRelativePath = path.join("sources", `${pageStem}.md`);
  const pagePath = path.join(params.config.vault.path, pageRelativePath);
  const created = !(await pathExists(pagePath));
  const existing = created ? "" : await readExistingSourcePage(pagePath);
  const parsed = parseWikiMarkdown(existing);
  const timestamp = resolveMemoryWikiTimestamp(params.nowMs);
  const ingestedAt =
    (typeof parsed.frontmatter.ingestedAt === "string" && parsed.frontmatter.ingestedAt.trim()) ||
    timestamp;
  const priorUpdatedAt =
    (typeof parsed.frontmatter.updatedAt === "string" && parsed.frontmatter.updatedAt.trim()) ||
    timestamp;
  const baseFrontmatter = { ...parsed.frontmatter };
  if (!params.evidence) {
    for (const key of EVIDENCE_FRONTMATTER_KEYS) {
      delete baseFrontmatter[key];
    }
  }
  const renderPage = (updatedAt: string) => {
    const sourceType = params.evidence?.sourceType || "local-file";
    const markdown = renderWikiMarkdown({
      frontmatter: {
        ...baseFrontmatter,
        pageType: "source",
        id: pageId,
        title,
        sourceType,
        sourcePath,
        ...(params.evidence
          ? {
              evidenceType: params.evidence.type,
              evidenceKind: params.evidence.kind,
              evidenceOrigin: params.evidence.origin,
              evidenceDirectness: params.evidence.directness,
              evidenceWeight: params.evidence.weight,
            }
          : {}),
        ingestedAt,
        updatedAt,
        status: "active",
      },
      body: [
        `# ${title}`,
        "",
        "## Source",
        `- Type: \`${sourceType}\``,
        ...(params.evidence
          ? [`- Evidence: \`${params.evidence.type}\` from \`${params.evidence.origin}\``]
          : []),
        `- Path: \`${sourcePath}\``,
        `- Bytes: ${buffer.byteLength}`,
        `- Updated: ${updatedAt}`,
        "",
        "## Content",
        renderMarkdownFence(content, "text"),
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
    });
    if (!existing) {
      return markdown;
    }
    return preserveGeneratedRelatedBlock(preserveHumanNotesBlock(markdown, existing), existing);
  };
  const unchangedCandidate = renderPage(priorUpdatedAt);
  const changed = existing !== unchangedCandidate;
  const finalMarkdown = changed ? renderPage(timestamp) : unchangedCandidate;

  if (changed && !params.dryRun) {
    await fs.writeFile(pagePath, finalMarkdown, "utf8");
    // If logging or compilation fails, readers must not keep using the pre-write snapshot.
    await invalidateMemoryWikiCompiledCache(params.config);
    await appendMemoryWikiLog(params.config.vault.path, {
      type: "ingest",
      timestamp,
      details: {
        inputPath: sourcePath,
        pageId,
        pagePath: pageRelativePath.split(path.sep).join("/"),
        bytes: buffer.byteLength,
        created,
      },
    });
  }
  const compile =
    !params.dryRun && params.compile !== false
      ? await compileMemoryWikiVault(params.config)
      : undefined;

  return {
    sourcePath,
    pageId,
    pagePath: pageRelativePath.split(path.sep).join("/"),
    title,
    bytes: buffer.byteLength,
    created,
    changed,
    indexUpdatedFiles: compile?.updatedFiles ?? [],
  };
}

export async function ingestMemoryWikiSourceBatchOperation(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  sourceBuffer: Buffer;
  title: string;
  dryRun?: boolean;
  evidence?: IngestMemoryWikiEvidence;
}): Promise<IngestMemoryWikiSourceResult> {
  return await withMemoryWikiVaultMutation(params.config.vault.path, () =>
    ingestMemoryWikiSourceUnlocked({
      ...params,
      compile: false,
      initialize: false,
    }),
  );
}

export async function ingestMemoryWikiSource(params: {
  config: ResolvedMemoryWikiConfig;
  inputPath: string;
  title?: string;
  nowMs?: number;
}): Promise<IngestMemoryWikiSourceResult> {
  // Ingest read-modify-writes the source page and recompiles the vault; hold
  // the vault mutation lock across the whole span so it cannot interleave
  // with the other serialized vault mutators (apply/compile/source-sync).
  return await withMemoryWikiVaultMutation(params.config.vault.path, () =>
    ingestMemoryWikiSourceUnlocked(params),
  );
}
