#!/usr/bin/env node

// Generates docs/docs_map.md from source docs headings for LLM navigation.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const DOCS_DIR = join(ROOT, "docs");
const OUTPUT_PATH = join(DOCS_DIR, "docs_map.md");
const MARKDOWN_EXTENSIONS = /\.mdx?$/iu;
const EXCLUDED_DIRS = new Set([
  ".generated",
  "archive",
  "assets",
  "images",
  "internal",
  "research",
  "snippets",
]);
const EXCLUDED_FILES = new Set(["AGENTS.md", "CLAUDE.md", "docs_map.md"]);

if (!existsSync(DOCS_DIR)) {
  console.error("docs:map: missing docs directory. Run from repo root.");
  process.exit(1);
}
if (!statSync(DOCS_DIR).isDirectory()) {
  console.error("docs:map: docs path is not a directory.");
  process.exit(1);
}

function normalizeSlashes(value) {
  return value.replace(/\\/gu, "/");
}

function isMarkdownFile(name) {
  return MARKDOWN_EXTENSIONS.test(name);
}

function shouldSkipFile(relativePath) {
  const parts = normalizeSlashes(relativePath).split("/");
  if (parts.some((part) => part.startsWith("."))) {
    return true;
  }
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return true;
  }
  return EXCLUDED_FILES.has(parts.at(-1));
}

function walkMarkdownFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    const relativePath = relative(base, fullPath);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      files.push(...walkMarkdownFiles(fullPath, base));
      continue;
    }
    if (!entry.isFile() || !isMarkdownFile(entry.name) || shouldSkipFile(relativePath)) {
      continue;
    }
    files.push(normalizeSlashes(relativePath));
  }
  return files.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
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

function renderDocsMap() {
  const files = walkMarkdownFiles(DOCS_DIR);
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
    const fullPath = join(DOCS_DIR, relativePath);
    const headings = extractHeadings(readFileSync(fullPath, "utf8"));
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

function main() {
  const check = process.argv.includes("--check");
  const content = renderDocsMap();

  if (check) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error("docs:map: docs/docs_map.md is missing. Run `pnpm docs:map:gen`.");
      process.exit(1);
    }
    const current = readFileSync(OUTPUT_PATH, "utf8");
    if (current !== content) {
      console.error("docs:map: docs/docs_map.md is out of date. Run `pnpm docs:map:gen`.");
      process.exit(1);
    }
    console.log("docs:map: docs/docs_map.md is up to date.");
    return;
  }

  writeFileSync(OUTPUT_PATH, content, "utf8");
  console.log(`docs:map: wrote ${normalizeSlashes(relative(ROOT, OUTPUT_PATH))}.`);
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isMain) {
  main();
}

export const testing = {
  cleanHeadingText,
};
