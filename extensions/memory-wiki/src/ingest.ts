// Memory Wiki plugin module implements ingest behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "openclaw/plugin-sdk/security-runtime";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
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
      renderMarkdownFence(content, "text"),
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
