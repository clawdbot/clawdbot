// Memory Wiki plugin module implements ingest behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  parseWikiMarkdown,
  preserveHumanNotesBlock,
  renderMarkdownFence,
  renderWikiMarkdown,
  slugifyWikiPageStem,
  slugifyWikiSegment,
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
  indexUpdatedFiles: string[];
};

function resolveSourceTitle(sourcePath: string, explicitTitle?: string): string {
  if (explicitTitle?.trim()) {
    return explicitTitle.trim();
  }
  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[-_]+/g, " ").trim();
}

function assertUtf8Text(buffer: Buffer, sourcePath: string): string {
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

/** Page-owned frontmatter keys that a source file must never override. */
const PAGE_OWNED_FRONTMATTER_KEYS = new Set([
  "pageType",
  "id",
  "title",
  "sourceType",
  "sourcePath",
  "ingestedAt",
  "updatedAt",
  "status",
]);

function isMarkdownSourcePath(sourcePath: string): boolean {
  const extension = path.extname(sourcePath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

/**
 * Render an ingested file's body. Markdown sources keep their body as real
 * Markdown (so headings/tables/links render as such) and may contribute valid
 * non-owned frontmatter keys (tags, url, date, ...). Non-Markdown inputs and
 * malformed/non-mapping frontmatter stay fenced as plain text.
 */
function renderIngestContent(params: { content: string; sourcePath: string }): {
  body: string;
  frontmatter: Record<string, unknown>;
} {
  if (!isMarkdownSourcePath(params.sourcePath)) {
    return { body: renderMarkdownFence(params.content, "text"), frontmatter: {} };
  }
  let parsed: ReturnType<typeof parseWikiMarkdown>;
  try {
    parsed = parseWikiMarkdown(params.content);
  } catch {
    // Malformed or non-mapping frontmatter: keep the whole input fenced so a
    // broken source cannot corrupt page structure or leak bogus metadata.
    return { body: renderMarkdownFence(params.content, "text"), frontmatter: {} };
  }
  const promoted = Object.fromEntries(
    Object.entries(parsed.frontmatter).filter(([key]) => !PAGE_OWNED_FRONTMATTER_KEYS.has(key)),
  );
  return { body: parsed.body.trim(), frontmatter: promoted };
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
  title?: string;
  nowMs?: number;
}): Promise<IngestMemoryWikiSourceResult> {
  await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
  const sourcePath = path.resolve(params.inputPath);
  const buffer = await fs.readFile(sourcePath);
  const content = assertUtf8Text(buffer, sourcePath);
  const title = resolveSourceTitle(sourcePath, params.title);
  const slug = slugifyWikiSegment(title);
  const pageStem = slugifyWikiPageStem(title);
  const pageId = `source.${slug}`;
  const pageRelativePath = path.join("sources", `${pageStem}.md`);
  const pagePath = path.join(params.config.vault.path, pageRelativePath);
  const created = !(await pathExists(pagePath));
  const timestamp = resolveMemoryWikiTimestamp(params.nowMs);
  const rendered = renderIngestContent({ content, sourcePath });

  const markdown = renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: pageId,
      title,
      sourceType: "local-file",
      sourcePath,
      ingestedAt: timestamp,
      updatedAt: timestamp,
      status: "active",
      // Non-owned keys lifted from a Markdown source's own frontmatter
      // (tags, url, date, ...). Page-owned keys above always win.
      ...rendered.frontmatter,
    },
    body: [
      `# ${title}`,
      "",
      "## Source",
      `- Type: \`local-file\``,
      `- Path: \`${sourcePath}\``,
      `- Bytes: ${buffer.byteLength}`,
      `- Updated: ${timestamp}`,
      "",
      "## Content",
      rendered.body,
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
  });

  const existing = created ? "" : await readExistingSourcePage(pagePath);
  await fs.writeFile(
    pagePath,
    existing ? preserveHumanNotesBlock(markdown, existing) : markdown,
    "utf8",
  );
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
  const compile = await compileMemoryWikiVault(params.config);

  return {
    sourcePath,
    pageId,
    pagePath: pageRelativePath.split(path.sep).join("/"),
    title,
    bytes: buffer.byteLength,
    created,
    indexUpdatedFiles: compile.updatedFiles,
  };
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
