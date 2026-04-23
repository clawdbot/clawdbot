#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { compile } from "@mdx-js/mdx";

const MINTLIFY_LANGUAGE_CODES = new Set([
  "en",
  "cn",
  "zh",
  "zh-Hans",
  "zh-Hant",
  "es",
  "fr",
  "fr-CA",
  "fr-ca",
  "ja",
  "jp",
  "ja-jp",
  "pt",
  "pt-BR",
  "de",
  "ko",
  "it",
  "ru",
  "ro",
  "cs",
  "id",
  "ar",
  "tr",
  "hi",
  "sv",
  "no",
  "lv",
  "nl",
  "uk",
  "vi",
  "pl",
  "uz",
  "he",
  "ca",
  "fi",
  "hu",
]);

function parseArgs(argv) {
  const roots = [];
  let jsonOut = "";
  let maxErrors = 50;

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === "--json-out") {
      jsonOut = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (part === "--max-errors") {
      maxErrors = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (part.startsWith("--")) {
      throw new Error(`unknown arg: ${part}`);
    }
    roots.push(part);
  }

  return {
    roots: roots.length ? roots : ["docs"],
    jsonOut,
    maxErrors: Number.isFinite(maxErrors) && maxErrors > 0 ? maxErrors : 50,
  };
}

function walkMarkdownFiles(entryPath, out = []) {
  const stat = fs.statSync(entryPath);
  if (stat.isFile()) {
    if (/\.mdx?$/i.test(entryPath)) {
      out.push(path.resolve(entryPath));
    }
    return out;
  }

  for (const entry of fs.readdirSync(entryPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    walkMarkdownFiles(path.join(entryPath, entry.name), out);
  }
  return out;
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

function formatMdxError(filePath, error) {
  const place = error?.place ?? error?.position;
  const start = place?.start ?? place;
  const line = typeof start?.line === "number" ? start.line : undefined;
  const column = typeof start?.column === "number" ? start.column : undefined;
  return {
    type: "mdx",
    file: filePath,
    line,
    column,
    message: String(error?.reason ?? error?.message ?? error).split("\n")[0],
  };
}

function checkMintlifyMdxStructure(filePath, raw) {
  const errors = [];
  const lines = stripFrontmatter(raw).split(/\r?\n/u);
  const accordionStack = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/u.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    const openAccordion = line.match(/^(\s*)<Accordion\b/u);
    if (openAccordion) {
      accordionStack.push({
        indent: openAccordion[1].length,
        line: index + 1,
        hasOutdentedListItem: false,
      });
      continue;
    }

    const listItem = line.match(/^(\s*)[-*+]\s+/u);
    if (listItem) {
      for (const accordion of accordionStack) {
        if (listItem[1].length < accordion.indent) {
          accordion.hasOutdentedListItem = true;
        }
      }
    }

    const closeAccordion = line.match(/^(\s*)<\/Accordion>/u);
    if (!closeAccordion) {
      continue;
    }

    const opening = accordionStack.pop();
    if (opening && opening.hasOutdentedListItem && closeAccordion[1].length > opening.indent) {
      errors.push({
        type: "mintlify-mdx",
        file: filePath,
        line: index + 1,
        column: closeAccordion[1].length + 1,
        message:
          "Accordion closing tag is indented deeper than its opening tag; Mintlify can parse following markdown as nested content.",
      });
    }
  }

  return errors;
}

async function checkMdxFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const structureErrors = checkMintlifyMdxStructure(filePath, raw);
  if (structureErrors.length > 0) {
    return structureErrors;
  }
  const value = stripFrontmatter(raw);
  await compile(
    { path: filePath, value },
    {
      development: false,
      jsx: false,
    },
  );
  return [];
}

function findDocsJsonPaths(roots) {
  const paths = new Set();
  for (const root of roots) {
    const absolute = path.resolve(root);
    if (!fs.existsSync(absolute)) {
      continue;
    }
    const stat = fs.statSync(absolute);
    if (stat.isFile() && path.basename(absolute) === "docs.json") {
      paths.add(absolute);
      continue;
    }
    if (stat.isDirectory()) {
      const docsJsonPath = path.join(absolute, "docs.json");
      if (fs.existsSync(docsJsonPath)) {
        paths.add(docsJsonPath);
      }
    }
  }
  return [...paths];
}

function collectNavigationLanguages(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNavigationLanguages(item, out);
    }
    return out;
  }
  if (!value || typeof value !== "object") {
    return out;
  }
  if (typeof value.language === "string") {
    out.push(value.language);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectNavigationLanguages(child, out);
    }
  }
  return out;
}

function checkDocsJson(filePath) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return [
      {
        type: "docs-json",
        file: filePath,
        message: `Invalid JSON: ${String(error?.message ?? error)}`,
      },
    ];
  }

  const languages = collectNavigationLanguages(data?.navigation);
  for (const language of languages) {
    if (!MINTLIFY_LANGUAGE_CODES.has(language)) {
      errors.push({
        type: "docs-json",
        file: filePath,
        message: `Unsupported Mintlify navigation language: ${language}`,
      });
    }
  }
  return errors;
}

function relativize(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const roots = args.roots.map((root) => path.resolve(root));
  const files = [
    ...new Set(
      roots.flatMap((root) => {
        if (!fs.existsSync(root)) {
          throw new Error(`path does not exist: ${root}`);
        }
        return walkMarkdownFiles(root);
      }),
    ),
  ].toSorted((left, right) => left.localeCompare(right));

  const errors = [];
  for (const docsJsonPath of findDocsJsonPaths(args.roots)) {
    errors.push(...checkDocsJson(docsJsonPath));
  }

  for (const file of files) {
    try {
      errors.push(...(await checkMdxFile(file)));
    } catch (error) {
      errors.push(formatMdxError(file, error));
      if (errors.length >= args.maxErrors) {
        break;
      }
    }
  }

  const report = {
    files: files.length,
    errors: errors.map((error) => Object.assign({}, error, { file: relativize(cwd, error.file) })),
    ms: Date.now() - startedAt,
  };

  if (args.jsonOut) {
    fs.mkdirSync(path.dirname(path.resolve(args.jsonOut)), { recursive: true });
    fs.writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (report.errors.length === 0) {
    console.log(`Docs MDX check passed (${report.files} files, ${report.ms}ms).`);
    return;
  }

  console.error(`Docs MDX check failed (${report.errors.length} error(s), ${report.files} files).`);
  for (const error of report.errors) {
    const location =
      error.line && error.column ? `${error.file}:${error.line}:${error.column}` : error.file;
    console.error(`- ${location}: ${error.message}`);
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
