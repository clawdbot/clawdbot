#!/usr/bin/env node

// Validates docs MDX files for syntax and repository-specific conventions.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@mdx-js/mdx";
import {
  checkMintlifyAccordionIndentation,
  MINTLIFY_ACCORDION_INDENT_MESSAGE,
} from "./lib/mintlify-accordion.mjs";

type DocsCheckError = {
  type: string;
  file: string;
  message: string;
  line?: number;
  column?: number;
};

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

const POISON_TEXT_PATTERNS = [
  {
    pattern: /\banalysis\s+to=functions\./iu,
    message: "Leaked tool-call channel marker.",
  },
  {
    pattern: /\b(?:commentary|final)\s+to=functions\./iu,
    message: "Leaked tool-call channel marker.",
  },
  {
    pattern: /\bfunctions\.(?:read|write|exec|search|run)\b/iu,
    message: "Leaked internal tool name.",
  },
  {
    pattern: /\b[A-Za-z_\u3400-\u9fff][\w\u3400-\u9fff-]*_input=\{/u,
    message: "Leaked tool-call input payload.",
  },
  {
    pattern: /<\/?openclaw_docs_i18n_input>/iu,
    message: "Leaked docs i18n prompt wrapper.",
  },
  {
    pattern: /\/home\/runner\/work\//u,
    message: "Leaked GitHub Actions workspace path.",
  },
  {
    pattern: /彩神马争霸/u,
    message: "Known spam/gambling text from a poisoned translation.",
  },
];

function parsePositiveIntegerArg(raw: string | undefined, label: string): number {
  const text = raw?.trim() ?? "";
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function readRequiredValue(argv: string[], index: number, label: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

/**
 * Parses docs MDX check arguments.
 */
export function parseArgs(argv: string[]) {
  const roots: string[] = [];
  let jsonOut = "";
  let maxErrors = 50;

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === undefined) {
      continue;
    }
    if (part === "--json-out") {
      jsonOut = readRequiredValue(argv, index, "--json-out");
      index += 1;
      continue;
    }
    if (part === "--max-errors") {
      maxErrors = parsePositiveIntegerArg(
        readRequiredValue(argv, index, "--max-errors"),
        "--max-errors",
      );
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
    maxErrors,
  };
}

function walkMarkdownFiles(entryPath: string, out: string[] = []): string[] {
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

function stripFrontmatter(raw: string): string {
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

function errorField(error: unknown, key: string): unknown {
  return error && typeof error === "object" && key in error
    ? error[key as keyof typeof error]
    : undefined;
}

function formatMdxError(filePath: string, error: unknown): DocsCheckError {
  const reason = errorField(error, "reason");
  const message = errorField(error, "message");
  const line = errorField(error, "line");
  const column = errorField(error, "column");
  return {
    type: "mdx",
    file: filePath,
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof column === "number" ? { column } : {}),
    message: String(reason ?? message ?? error).split("\n")[0] ?? "",
  };
}

function checkMintlifyMdxStructure(filePath: string, raw: string): DocsCheckError[] {
  return checkMintlifyAccordionIndentation(stripFrontmatter(raw)).map((error) => ({
    type: "mintlify-mdx",
    file: filePath,
    line: error.line,
    column: error.column,
    message: MINTLIFY_ACCORDION_INDENT_MESSAGE,
  }));
}

function lineColumnForIndex(raw: string, offset: number): { line: number; column: number } {
  const prefix = raw.slice(0, offset);
  const lines = prefix.split(/\r?\n/u);
  return {
    line: lines.length,
    column: (lines.at(-1) ?? "").length + 1,
  };
}

function checkPoisonText(filePath: string, raw: string): DocsCheckError[] {
  const errors: DocsCheckError[] = [];
  for (const { pattern, message } of POISON_TEXT_PATTERNS) {
    const match = pattern.exec(raw);
    if (!match) {
      continue;
    }
    const location = lineColumnForIndex(raw, match.index);
    errors.push({
      type: "poison-text",
      file: filePath,
      line: location.line,
      column: location.column,
      message,
    });
  }
  return errors;
}

async function checkMdxFile(filePath: string): Promise<DocsCheckError[]> {
  const raw = fs.readFileSync(filePath, "utf8");
  const poisonErrors = checkPoisonText(filePath, raw);
  if (poisonErrors.length > 0) {
    return poisonErrors;
  }
  const structureErrors = checkMintlifyMdxStructure(filePath, raw);
  if (structureErrors.length > 0) {
    return structureErrors;
  }
  await compile({ path: filePath, value: stripFrontmatter(raw) });
  return [];
}

function findDocsJsonPaths(roots: string[]): string[] {
  const paths = new Set<string>();
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

function collectNavigationLanguages(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNavigationLanguages(item, out);
    }
    return out;
  }
  if (!value || typeof value !== "object") {
    return out;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.language === "string") {
    out.push(record.language);
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      collectNavigationLanguages(child, out);
    }
  }
  return out;
}

function checkDocsJson(filePath: string): DocsCheckError[] {
  const errors: DocsCheckError[] = [];
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return [
      {
        type: "docs-json",
        file: filePath,
        message: `Invalid JSON: ${String(errorField(error, "message") ?? error)}`,
      },
    ];
  }

  const navigation =
    data && typeof data === "object" && "navigation" in data ? data.navigation : undefined;
  const languages = collectNavigationLanguages(navigation);
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

function relativize(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

async function main(): Promise<void> {
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

  const errors: DocsCheckError[] = [];
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

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(errorField(error, "stack") ?? error);
    process.exit(1);
  });
}
