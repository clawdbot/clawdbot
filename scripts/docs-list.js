#!/usr/bin/env node

// Lists source docs pages and renders on-demand heading metadata for docs-aware tooling.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_DIR = join(process.cwd(), "docs");
const DOCS_LIST_EXCLUDED_DIRS = new Set(["archive", "research"]);
const DOCS_MAP_EXCLUDED_DIRS = new Set([
  ".generated",
  "archive",
  "assets",
  "images",
  "internal",
  "research",
  "snippets",
]);
const DOCS_MAP_EXCLUDED_FILES = new Set(["AGENTS.md", "CLAUDE.md", "docs_map.md"]);

function assertDocsDir(docsDir) {
  if (!existsSync(docsDir)) {
    throw new Error("docs:list: missing docs directory. Run from repo root.");
  }
  if (!statSync(docsDir).isDirectory()) {
    throw new Error("docs:list: docs path is not a directory.");
  }
}

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function compactStrings(values) {
  const result = [];
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const normalized =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number" || typeof value === "boolean"
          ? String(value).trim()
          : null;

    if (normalized?.length > 0) {
      result.push(normalized);
    }
  }
  return result;
}

/**
 * @param {string} dir
 * @param {string} base
 * @param {{
 *   excludedDirs?: Set<string>;
 *   excludedFiles?: Set<string>;
 *   relativePath?: (base: string, fullPath: string) => string;
 * }} options
 * @returns {string[]}
 */
function walkMarkdownFiles(dir, base = dir, options = {}) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (options.excludedDirs?.has(entry.name)) {
        continue;
      }
      files.push(...walkMarkdownFiles(fullPath, base, options));
    } else if (
      entry.isFile() &&
      /\.(md|mdx)$/iu.test(entry.name) &&
      !options.excludedFiles?.has(entry.name)
    ) {
      files.push((options.relativePath ?? relative)(base, fullPath));
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

/**
 * @param {string} fullPath
 * @returns {{ summary: string | null; readWhen: string[]; error?: string }}
 */
function extractMetadata(fullPath) {
  const content = readFileSync(fullPath, "utf8");

  if (!content.startsWith("---")) {
    return { summary: null, readWhen: [], error: "missing front matter" };
  }

  const endIndex = content.search(/\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u);
  if (endIndex === -1) {
    return { summary: null, readWhen: [], error: "unterminated front matter" };
  }

  const frontMatter = content.slice(3, endIndex).trim();
  const lines = frontMatter.split("\n");

  let summaryLine = null;
  const readWhen = [];
  let collectingField = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("summary:")) {
      summaryLine = line;
      collectingField = null;
      continue;
    }

    if (line.startsWith("read_when:")) {
      collectingField = "read_when";
      const inline = line.slice("read_when:".length).trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        try {
          const parsed = JSON.parse(inline.replace(/'/g, '"'));
          if (Array.isArray(parsed)) {
            readWhen.push(...compactStrings(parsed));
          }
        } catch {
          // ignore malformed inline arrays
        }
      } else if (
        (inline.startsWith('"') && inline.endsWith('"')) ||
        (inline.startsWith("'") && inline.endsWith("'"))
      ) {
        readWhen.push(...compactStrings([inline.slice(1, -1)]));
      }
      continue;
    }

    if (collectingField === "read_when") {
      if (line.startsWith("- ")) {
        const hint = line.slice(2).trim();
        if (hint) {
          readWhen.push(hint);
        }
      } else if (line === "") {
        // allow blank lines inside the list
      } else {
        collectingField = null;
      }
    }
  }

  if (!summaryLine) {
    return { summary: null, readWhen, error: "summary key missing" };
  }

  const summaryValue = summaryLine.slice("summary:".length).trim();
  const normalized = summaryValue
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return { summary: null, readWhen, error: "summary is empty" };
  }

  return { summary: normalized, readWhen };
}

function stripFrontmatter(raw) {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return raw;
  }
  const lines = raw.split(/\r?\n/u);
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---" || lines[index] === "...") {
      return lines.slice(index + 1).join("\n");
    }
  }
  return raw;
}

function escapeMarkdownHtmlText(value) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function cleanHeadingText(value) {
  const codeSpans = [];
  const withCodePlaceholders = value.replace(/(`+)([^`\n]*?)\1/gu, (_match, _ticks, content) => {
    const index = codeSpans.push(content) - 1;
    return `\u{e000}${index}\u{e001}`;
  });
  const normalized = withCodePlaceholders
    .replace(/\s+#+\s*$/u, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\u{e000}(\d+)\u{e001}/gu, (_match, index) => {
      const content = codeSpans[Number(index)] ?? "";
      return /[*_~[\]()!]/u.test(content) ? `\`${content}\`` : content;
    });
  // Docs map is Markdown consumed by humans and agents. Escape HTML instead of
  // trying to strip tags so malformed source headings cannot reintroduce markup.
  return escapeMarkdownHtmlText(normalized);
}

function extractHeadings(raw) {
  const headings = [];
  const lines = stripFrontmatter(raw).split(/\r?\n/u);
  let fenceMarker = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const fenceMatch = /^(?<marker>`{3,}|~{3,})/u.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch.groups.marker[0];
      fenceMarker = fenceMarker === marker ? null : (fenceMarker ?? marker);
      continue;
    }
    if (fenceMarker) {
      continue;
    }

    const match = /^(#{1,4})\s+(.+)$/u.exec(rawLine);
    if (!match) {
      continue;
    }
    const text = cleanHeadingText(match[2]);
    if (text) {
      headings.push({ depth: match[1].length, text });
    }
  }

  return headings;
}

function routeForFile(relativePath) {
  const withoutExtension = relativePath.replace(/\.mdx?$/iu, "");
  if (withoutExtension === "index") {
    return "/";
  }
  if (withoutExtension.endsWith("/index")) {
    return `/${withoutExtension.slice(0, -"/index".length)}`;
  }
  return `/${withoutExtension}`;
}

function normalizeDocsMapRelativePath(relativePath) {
  return relativePath.replace(/\\/gu, "/");
}

/** Render the publish-only docs heading map without creating a source-tree mirror. */
export function renderDocsHeadingMap(docsDir = DOCS_DIR, options = {}) {
  assertDocsDir(docsDir);
  const files = walkMarkdownFiles(docsDir, docsDir, {
    excludedDirs: DOCS_MAP_EXCLUDED_DIRS,
    excludedFiles: DOCS_MAP_EXCLUDED_FILES,
    relativePath: options.relativePath,
  })
    .map(normalizeDocsMapRelativePath)
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const lines = [
    "---",
    'summary: "Generated heading map for OpenClaw docs pages"',
    'read_when: "Finding which docs page covers a topic before reading the page"',
    'title: "Docs map"',
    "---",
    "",
    "# OpenClaw docs map",
    "",
    "This file is generated from `docs/**/*.md` and `docs/**/*.mdx` headings to help agents navigate the documentation tree.",
    "Do not edit it by hand; run `pnpm docs:map:gen`.",
    "",
  ];

  for (const relativePath of files) {
    const headings = extractHeadings(readFileSync(join(docsDir, relativePath), "utf8"));
    lines.push(`## ${relativePath}`);
    lines.push("");
    lines.push(`- Route: ${routeForFile(relativePath)}`);
    if (headings.length === 0) {
      lines.push("- Headings: none");
    } else {
      lines.push("- Headings:");
      for (const heading of headings) {
        lines.push(`  - H${heading.depth}: ${heading.text}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function runDocsList(docsDir = DOCS_DIR) {
  assertDocsDir(docsDir);
  console.log("Listing all markdown files in docs folder:");
  const markdownFiles = walkMarkdownFiles(docsDir, docsDir, {
    excludedDirs: DOCS_LIST_EXCLUDED_DIRS,
  });

  for (const relativePath of markdownFiles) {
    const fullPath = join(docsDir, relativePath);
    const { summary, readWhen, error } = extractMetadata(fullPath);
    if (summary) {
      console.log(`${relativePath} - ${summary}`);
      if (readWhen.length > 0) {
        console.log(`  Read when: ${readWhen.join("; ")}`);
      }
    } else {
      const reason = error ? ` - [${error}]` : "";
      console.log(`${relativePath}${reason}`);
    }
  }

  console.log(
    '\nReminder: keep docs up to date as behavior changes. When your task matches any "Read when" hint above (React hooks, cache directives, database work, tests, etc.), read that doc before coding, and suggest new coverage when it is missing.',
  );
}

function main(argv = process.argv.slice(2)) {
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") {
      process.exit(0);
    }
    throw error;
  });
  if (argv.length === 0) {
    runDocsList();
    return;
  }
  if (argv.length === 1 && argv[0] === "--headings") {
    process.stdout.write(renderDocsHeadingMap());
    return;
  }
  console.error("Usage: pnpm docs:list [--headings]");
  process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
