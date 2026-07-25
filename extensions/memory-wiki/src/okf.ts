// Memory Wiki plugin module implements Open Knowledge Format import behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeOptionalString,
  normalizeSingleOrTrimmedStringList,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { compileMemoryWikiVault } from "./compile.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { appendMemoryWikiLog } from "./log.js";
import {
  createWikiPageFilename,
  parseWikiMarkdown,
  renderWikiMarkdown,
  slugifyWikiSegment,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { resolveMemoryWikiTimestamp } from "./time.js";
import { isRegularFileStat, writeGuardedVaultPage } from "./vault-page-write.js";
import { initializeMemoryWikiVault } from "./vault.js";

const OKF_RESERVED_FILENAMES = new Set(["index.md", "log.md"]);
const OKF_MARKDOWN_LINK_PATTERN = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
const OKF_FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const OKF_RELATED_SECTION_PATTERN = new RegExp(
  `\\n+## Related\\n${WIKI_RELATED_START_MARKER}[\\s\\S]*?${WIKI_RELATED_END_MARKER}\\n?`,
  "g",
);
const OKF_VOLATILE_TIMESTAMP_LINE_PATTERN = /^(?:importedAt|updatedAt): .*\n/gm;
const OKF_HASH_CHARS = 8;

type OkfConceptDocument = {
  conceptId: string;
  relativePath: string;
  absolutePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  type: string;
  title: string;
  description?: string;
  resource?: string;
  tags: string[];
  timestamp?: string;
};

type OkfImportedPage = {
  conceptId: string;
  sourcePath: string;
  pageId: string;
  pagePath: string;
  title: string;
  created: boolean;
};

type ImportMemoryWikiOkfWarning = {
  code: "invalid-concept" | "missing-type" | "unreadable-entry";
  path: string;
  message: string;
};

type ImportMemoryWikiOkfResult = {
  bundlePath: string;
  bundleName: string;
  okfVersion?: string;
  importedCount: number;
  updatedCount: number;
  removedCount: number;
  skippedCount: number;
  pagePaths: string[];
  removedPagePaths: string[];
  warnings: ImportMemoryWikiOkfWarning[];
  indexUpdatedFiles: string[];
};

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function trimMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

type OkfBundleMetadata = {
  key: string;
  version?: string;
};

function createOkfBundleKey(params: {
  rootFrontmatter: Record<string, unknown>;
  bundleName: string;
  bundlePath: string;
}): string {
  const producerId =
    normalizeOptionalString(params.rootFrontmatter.id) ??
    normalizeOptionalString(params.rootFrontmatter.okf_id);
  if (producerId) {
    return slugifyWikiSegment(producerId);
  }
  const label =
    normalizeOptionalString(params.rootFrontmatter.name) ??
    normalizeOptionalString(params.rootFrontmatter.title) ??
    params.bundleName;
  const hash = createHash("sha1").update(params.bundlePath).digest("hex").slice(0, OKF_HASH_CHARS);
  return `${slugifyWikiSegment(label)}-${hash}`;
}

function createOkfPageStem(bundleKey: string, conceptId: string): string {
  const slug = slugifyWikiSegment(conceptId.replace(/\//g, "-"));
  const hash = createHash("sha1").update(conceptId).digest("hex").slice(0, OKF_HASH_CHARS);
  return `okf-${bundleKey}-${slug}-${hash}`;
}

function createOkfPageIdentity(
  bundleKey: string,
  conceptId: string,
): { pageId: string; pagePath: string } {
  const fileName = createWikiPageFilename(createOkfPageStem(bundleKey, conceptId));
  const stem = trimMarkdownExtension(fileName);
  return {
    pageId: `concept.${stem}`,
    pagePath: `concepts/${fileName}`,
  };
}

async function collectOkfMarkdownFiles(
  rootDir: string,
  warnings: ImportMemoryWikiOkfWarning[],
): Promise<string[]> {
  async function walk(relativeDir: string): Promise<string[]> {
    const absoluteDir = path.join(rootDir, relativeDir);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch((err: unknown) => {
      warnings.push({
        code: "unreadable-entry",
        path: toPosixPath(relativeDir) || ".",
        message: err instanceof Error ? err.message : "Unable to read OKF directory.",
      });
      return [];
    });
    const files: string[] = [];
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(relativePath)));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(relativePath);
      }
    }
    return files;
  }

  return (await walk("")).map(toPosixPath).toSorted((left, right) => left.localeCompare(right));
}

function parseOkfMarkdown(
  content: string,
  relativePath: string,
): {
  frontmatter: Record<string, unknown>;
  body: string;
  warning?: ImportMemoryWikiOkfWarning;
} {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  try {
    return parseWikiMarkdown(normalizedContent);
  } catch (err) {
    return {
      frontmatter: {},
      body: normalizedContent,
      warning: {
        code: "invalid-concept",
        path: relativePath,
        message: err instanceof Error ? err.message : "Unable to parse OKF frontmatter.",
      },
    };
  }
}

async function readOkfTextFile(params: {
  bundlePath: string;
  relativePath: string;
  warnings: ImportMemoryWikiOkfWarning[];
}): Promise<string | null> {
  const root = await fsRoot(params.bundlePath);
  const stat = await root.stat(params.relativePath).catch((err: unknown) => {
    params.warnings.push({
      code: "unreadable-entry",
      path: params.relativePath,
      message: err instanceof Error ? err.message : "Unable to read OKF concept.",
    });
    return null;
  });
  if (!stat) {
    return null;
  }
  if (!isRegularFileStat(stat)) {
    params.warnings.push({
      code: "unreadable-entry",
      path: params.relativePath,
      message: "Refusing to import OKF concept through non-regular or hardlinked file.",
    });
    return null;
  }
  return await root.readText(params.relativePath).catch((err: unknown) => {
    params.warnings.push({
      code: "unreadable-entry",
      path: params.relativePath,
      message: err instanceof Error ? err.message : "Unable to read OKF concept.",
    });
    return null;
  });
}

function deriveOkfTitle(relativePath: string, frontmatter: Record<string, unknown>): string {
  return (
    normalizeOptionalString(frontmatter.title) ??
    path.posix.basename(relativePath, ".md").replace(/[-_]+/g, " ").trim() ??
    trimMarkdownExtension(relativePath)
  );
}

function normalizeOkfConcept(params: {
  bundlePath: string;
  relativePath: string;
  content: string;
}): { concept?: OkfConceptDocument; warning?: ImportMemoryWikiOkfWarning } {
  const parsed = parseOkfMarkdown(params.content, params.relativePath);
  if (parsed.warning) {
    return { warning: parsed.warning };
  }

  const type = normalizeOptionalString(parsed.frontmatter.type);
  if (!type) {
    return {
      warning: {
        code: "missing-type",
        path: params.relativePath,
        message: "OKF concept is missing required non-empty type frontmatter.",
      },
    };
  }

  const conceptId = trimMarkdownExtension(params.relativePath);
  const timestamp = normalizeOptionalString(parsed.frontmatter.timestamp);
  return {
    concept: {
      conceptId,
      relativePath: params.relativePath,
      absolutePath: path.join(params.bundlePath, params.relativePath),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      type,
      title: deriveOkfTitle(params.relativePath, parsed.frontmatter),
      ...(normalizeOptionalString(parsed.frontmatter.description)
        ? { description: normalizeOptionalString(parsed.frontmatter.description) }
        : {}),
      ...(normalizeOptionalString(parsed.frontmatter.resource)
        ? { resource: normalizeOptionalString(parsed.frontmatter.resource) }
        : {}),
      tags: normalizeSingleOrTrimmedStringList(parsed.frontmatter.tags),
      ...(timestamp ? { timestamp } : {}),
    },
  };
}

function splitMarkdownLinkDestination(target: string): {
  destination: string;
  titleSuffix: string;
} {
  const trimmed = target.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    if (end > 0) {
      return {
        destination: trimmed.slice(1, end),
        titleSuffix: trimmed.slice(end + 1),
      };
    }
  }
  const match = trimmed.match(/^(\S+)(\s+[\s\S]+)?$/);
  return {
    destination: match?.[1] ?? trimmed,
    titleSuffix: match?.[2] ?? "",
  };
}

function resolveOkfMarkdownTarget(sourceRelativePath: string, target: string): string | null {
  const { destination } = splitMarkdownLinkDestination(target);
  const trimmed = destination.trim();
  if (!trimmed || trimmed.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }

  const rawTargetWithoutSuffix = trimmed.split("#")[0]?.split("?")[0]?.replace(/\\/g, "/").trim();
  const targetWithoutSuffix = safeDecodeOkfLinkPath(rawTargetWithoutSuffix);
  if (!targetWithoutSuffix || !targetWithoutSuffix.endsWith(".md")) {
    return null;
  }

  const normalized = targetWithoutSuffix.startsWith("/")
    ? path.posix.normalize(targetWithoutSuffix.slice(1))
    : path.posix.normalize(
        path.posix.join(path.posix.dirname(sourceRelativePath), targetWithoutSuffix),
      );
  const conceptId = trimMarkdownExtension(normalized);
  return conceptId.startsWith("../") ? null : conceptId;
}

function safeDecodeOkfLinkPath(value: string | undefined): string {
  if (!value) {
    return "";
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getMarkdownDestinationSuffix(destination: string): string {
  const queryIndex = destination.indexOf("?");
  const fragmentIndex = destination.indexOf("#");
  const suffixIndex =
    queryIndex === -1
      ? fragmentIndex
      : fragmentIndex === -1
        ? queryIndex
        : Math.min(queryIndex, fragmentIndex);
  return suffixIndex === -1 ? "" : destination.slice(suffixIndex);
}

function rewriteOkfMarkdownLinks(params: {
  body: string;
  sourcePagePath: string;
  sourceRelativePath: string;
  pageByConceptId: Map<string, { pageId: string; pagePath: string; title: string }>;
}): { body: string; linkedConceptIds: string[] } {
  const linkedConceptIds: string[] = [];
  const rewriteLinks = (markdown: string) =>
    markdown.replace(
      OKF_MARKDOWN_LINK_PATTERN,
      (match, imagePrefix: string, label: string, rawTarget: string) => {
        const conceptId = resolveOkfMarkdownTarget(params.sourceRelativePath, rawTarget);
        if (!conceptId) {
          return match;
        }
        const target = params.pageByConceptId.get(conceptId);
        if (!target) {
          return match;
        }
        linkedConceptIds.push(conceptId);
        const { destination, titleSuffix } = splitMarkdownLinkDestination(rawTarget);
        const relativeTarget = path.posix.relative(
          path.posix.dirname(params.sourcePagePath),
          target.pagePath,
        );
        const suffix = getMarkdownDestinationSuffix(destination);
        return `${imagePrefix}[${label}](${relativeTarget}${suffix}${titleSuffix})`;
      },
    );
  const body = rewriteMarkdownOutsideCode(params.body, rewriteLinks);
  return { body, linkedConceptIds: uniqueStrings(linkedConceptIds) };
}

function rewriteMarkdownLineOutsideInlineCode(
  line: string,
  rewriteLinks: (markdown: string) => string,
): string {
  let result = "";
  let cursor = 0;
  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);
    if (codeStart === -1) {
      result += rewriteLinks(line.slice(cursor));
      break;
    }
    result += rewriteLinks(line.slice(cursor, codeStart));
    const delimiter = line.slice(codeStart).match(/^`+/)?.[0] ?? "`";
    const codeEnd = line.indexOf(delimiter, codeStart + delimiter.length);
    if (codeEnd === -1) {
      result += line.slice(codeStart);
      break;
    }
    result += line.slice(codeStart, codeEnd + delimiter.length);
    cursor = codeEnd + delimiter.length;
  }
  return result;
}

function rewriteMarkdownOutsideCode(
  markdown: string,
  rewriteLinks: (markdown: string) => string,
): string {
  const lines = markdown.split(/(\n)/);
  let inFence = false;
  let fenceDelimiter = "";
  return lines
    .map((line) => {
      if (line === "\n") {
        return line;
      }
      const fenceMatch = line.match(OKF_FENCE_PATTERN);
      if (fenceMatch) {
        const delimiter = fenceMatch[1] ?? "";
        const closesFence =
          inFence &&
          delimiter.startsWith(fenceDelimiter[0] ?? "") &&
          delimiter.length >= fenceDelimiter.length;
        const opensFence = !inFence;
        if (opensFence) {
          inFence = true;
          fenceDelimiter = delimiter;
        } else if (closesFence) {
          inFence = false;
          fenceDelimiter = "";
        }
        return line;
      }
      return inFence ? line : rewriteMarkdownLineOutsideInlineCode(line, rewriteLinks);
    })
    .join("");
}

function normalizeOkfRenderedPageForComparison(content: string): string {
  const withoutRelated = content.replace(OKF_RELATED_SECTION_PATTERN, "\n");
  const frontmatterMatch = withoutRelated.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontmatterMatch) {
    return withoutRelated.trimEnd();
  }
  const normalizedFrontmatter =
    frontmatterMatch[1]?.replace(OKF_VOLATILE_TIMESTAMP_LINE_PATTERN, "") ?? "";
  const frontmatterBody = normalizedFrontmatter.endsWith("\n")
    ? normalizedFrontmatter
    : `${normalizedFrontmatter}\n`;
  return `---\n${frontmatterBody}---\n${withoutRelated.slice(frontmatterMatch[0].length)}`.trimEnd();
}

async function writeOkfConceptPage(params: {
  vaultRoot: string;
  pagePath: string;
  content: string;
}): Promise<{ changed: boolean; created: boolean }> {
  const vault = await fsRoot(params.vaultRoot);
  const pageStat = await vault.stat(params.pagePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
  const existing = pageStat ? await vault.readText(params.pagePath).catch(() => "") : "";
  if (
    existing === params.content ||
    normalizeOkfRenderedPageForComparison(existing) ===
      normalizeOkfRenderedPageForComparison(params.content)
  ) {
    return { changed: false, created: !pageStat };
  }
  await writeGuardedVaultPage({
    vault,
    pagePath: params.pagePath,
    content: params.content,
    pageStat,
    pageLabel: "OKF concept page",
  });
  return { changed: true, created: !pageStat };
}

async function removeStaleOkfConceptPages(params: {
  vaultRoot: string;
  bundleKey: string;
  currentPagePaths: Set<string>;
}): Promise<string[]> {
  const vault = await fsRoot(params.vaultRoot);
  const conceptsDir = path.join(params.vaultRoot, "concepts");
  const entries = await fs.readdir(conceptsDir, { withFileTypes: true }).catch(() => []);
  const removedPagePaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
      continue;
    }
    const pagePath = `concepts/${entry.name}`;
    if (params.currentPagePaths.has(pagePath)) {
      continue;
    }
    const raw = await vault.readText(pagePath).catch(() => "");
    const parsed = parseWikiMarkdown(raw);
    const okf = parsed.frontmatter.okf;
    if (
      okf &&
      typeof okf === "object" &&
      !Array.isArray(okf) &&
      (okf as Record<string, unknown>).bundleKey === params.bundleKey
    ) {
      await vault.remove(pagePath);
      removedPagePaths.push(pagePath);
    }
  }
  return removedPagePaths;
}

function readRootOkfMetadata(params: {
  rootIndex: string | undefined;
  bundleName: string;
  bundlePath: string;
}): OkfBundleMetadata {
  if (!params.rootIndex) {
    return {
      key: createOkfBundleKey({
        rootFrontmatter: {},
        bundleName: params.bundleName,
        bundlePath: params.bundlePath,
      }),
    };
  }
  const parsed = parseOkfMarkdown(params.rootIndex, "index.md");
  return {
    key: createOkfBundleKey({
      rootFrontmatter: parsed.frontmatter,
      bundleName: params.bundleName,
      bundlePath: params.bundlePath,
    }),
    ...(normalizeOptionalString(parsed.frontmatter.okf_version)
      ? { version: normalizeOptionalString(parsed.frontmatter.okf_version) }
      : {}),
  };
}

function formatOkfImportSummary(result: ImportMemoryWikiOkfResult): string {
  return `Imported ${result.importedCount} OKF concept${result.importedCount === 1 ? "" : "s"} from ${result.bundlePath} into memory wiki. Updated ${result.updatedCount}; removed ${result.removedCount}; skipped ${result.skippedCount}; refreshed ${result.indexUpdatedFiles.length} index file${result.indexUpdatedFiles.length === 1 ? "" : "s"}.`;
}

export { formatOkfImportSummary };

export async function importMemoryWikiOkfBundle(params: {
  config: ResolvedMemoryWikiConfig;
  bundlePath: string;
  nowMs?: number;
}): Promise<ImportMemoryWikiOkfResult> {
  await initializeMemoryWikiVault(params.config, { nowMs: params.nowMs });
  const bundlePath = path.resolve(params.bundlePath);
  const stat = await fs.stat(bundlePath);
  if (!stat.isDirectory()) {
    throw new Error("wiki okf import expects an unpacked OKF bundle directory.");
  }

  const warnings: ImportMemoryWikiOkfWarning[] = [];
  const markdownFiles = await collectOkfMarkdownFiles(bundlePath, warnings);
  const concepts: OkfConceptDocument[] = [];
  let rootIndexContent: string | undefined;

  for (const relativePath of markdownFiles) {
    if (relativePath === "index.md") {
      rootIndexContent =
        (await readOkfTextFile({ bundlePath, relativePath, warnings })) ?? undefined;
    }
    if (OKF_RESERVED_FILENAMES.has(path.posix.basename(relativePath))) {
      continue;
    }
    const content = await readOkfTextFile({ bundlePath, relativePath, warnings });
    if (content === null) {
      continue;
    }
    const normalized = normalizeOkfConcept({ bundlePath, relativePath, content });
    if (normalized.warning) {
      warnings.push(normalized.warning);
      continue;
    }
    if (normalized.concept) {
      concepts.push(normalized.concept);
    }
  }

  const timestamp = resolveMemoryWikiTimestamp(params.nowMs);
  const bundleName = path.basename(bundlePath);
  const bundleMetadata = readRootOkfMetadata({
    rootIndex: rootIndexContent,
    bundleName,
    bundlePath,
  });
  const bundleKey = bundleMetadata.key;
  const pageByConceptId = new Map<string, { pageId: string; pagePath: string; title: string }>();
  for (const concept of concepts) {
    pageByConceptId.set(concept.conceptId, {
      ...createOkfPageIdentity(bundleKey, concept.conceptId),
      title: concept.title,
    });
  }

  const importedPages: OkfImportedPage[] = [];
  let updatedCount = 0;

  await fs.mkdir(path.join(params.config.vault.path, "concepts"), { recursive: true });
  for (const concept of concepts.toSorted((left, right) =>
    left.conceptId.localeCompare(right.conceptId),
  )) {
    const page = pageByConceptId.get(concept.conceptId);
    if (!page) {
      continue;
    }
    const rewritten = rewriteOkfMarkdownLinks({
      body: concept.body,
      sourcePagePath: page.pagePath,
      sourceRelativePath: concept.relativePath,
      pageByConceptId,
    });
    const relationships = rewritten.linkedConceptIds.flatMap((conceptId) => {
      const target = pageByConceptId.get(conceptId);
      return target
        ? [
            {
              targetId: target.pageId,
              targetPath: target.pagePath,
              targetTitle: target.title,
              kind: "okf-link",
              evidenceKind: "okf-markdown-link",
            },
          ]
        : [];
    });

    const frontmatter = {
      pageType: "concept",
      id: page.pageId,
      title: concept.title,
      sourceType: "okf",
      provenanceMode: "okf-import",
      sourcePath: concept.absolutePath,
      okfConceptId: concept.conceptId,
      okfType: concept.type,
      sourceIds: [`source.okf.${bundleKey}`],
      importedAt: timestamp,
      updatedAt: concept.timestamp ?? timestamp,
      status: "active",
      ...(concept.description ? { description: concept.description } : {}),
      ...(concept.resource ? { resource: concept.resource } : {}),
      ...(concept.tags.length > 0 ? { tags: concept.tags } : {}),
      ...(concept.timestamp ? { okfTimestamp: concept.timestamp } : {}),
      ...(relationships.length > 0 ? { relationships } : {}),
      okf: {
        ...(bundleMetadata.version ? { version: bundleMetadata.version } : {}),
        bundleName,
        bundleKey,
        conceptId: concept.conceptId,
        sourceRelativePath: concept.relativePath,
        frontmatter: concept.frontmatter,
      },
    };

    const writeResult = await writeOkfConceptPage({
      vaultRoot: params.config.vault.path,
      pagePath: page.pagePath,
      content: renderWikiMarkdown({
        frontmatter,
        body: rewritten.body,
      }),
    });
    if (!writeResult.created && writeResult.changed) {
      updatedCount++;
    }
    importedPages.push({
      conceptId: concept.conceptId,
      sourcePath: concept.absolutePath,
      pageId: page.pageId,
      pagePath: page.pagePath,
      title: concept.title,
      created: writeResult.created,
    });
  }
  const currentPagePaths = new Set(importedPages.map((page) => page.pagePath));
  const removedPagePaths =
    warnings.length === 0
      ? await removeStaleOkfConceptPages({
          vaultRoot: params.config.vault.path,
          bundleKey,
          currentPagePaths,
        })
      : [];

  await appendMemoryWikiLog(params.config.vault.path, {
    type: "okf-import",
    timestamp,
    details: {
      bundlePath,
      bundleName,
      importedCount: importedPages.length,
      updatedCount,
      removedCount: removedPagePaths.length,
      skippedCount: warnings.length,
      pagePaths: importedPages.map((page) => page.pagePath),
      removedPagePaths,
    },
  });

  const compile = await compileMemoryWikiVault(params.config);
  return {
    bundlePath,
    bundleName,
    ...(bundleMetadata.version ? { okfVersion: bundleMetadata.version } : {}),
    importedCount: importedPages.length,
    updatedCount,
    removedCount: removedPagePaths.length,
    skippedCount: warnings.length,
    pagePaths: importedPages.map((page) => page.pagePath),
    removedPagePaths,
    warnings,
    indexUpdatedFiles: compile.updatedFiles,
  };
}
