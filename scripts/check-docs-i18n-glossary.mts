#!/usr/bin/env node

// Validates docs i18n glossary terms against configured usage rules.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireOptionArgument } from "./lib/arg-utils.mts";

const ROOT = process.cwd();
const GLOSSARY_PATH = path.join(ROOT, "docs", ".i18n", "glossary.zh-CN.json");
const DOC_FILE_RE = /^docs\/(?!zh-CN\/).+\.(md|mdx)$/i;
const LIST_ITEM_LINK_RE = /^\s*(?:[-*]|\d+\.)\s+\[([^\]]+)\]\((\/[^)]+)\)/;
const MAX_TITLE_WORDS = 8;
const MAX_LABEL_WORDS = 6;
const MAX_TERM_LENGTH = 80;

type TermMatch = {
  file: string;
  line: number;
  kind: "title" | "link label";
  term: string;
};

export function parseArgs(argv: string[]) {
  const args = { base: "", head: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = requireOptionArgument(argv, i, "--base");
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = requireOptionArgument(argv, i, "--head");
      i += 1;
    }
  }
  return args;
}

function runGit(args: string[]) {
  return execFileSync("git", args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function resolveBase(explicitBase: string) {
  if (explicitBase) {
    return explicitBase;
  }

  const envBase = process.env.DOCS_I18N_GLOSSARY_BASE?.trim();
  if (envBase) {
    return envBase;
  }

  for (const candidate of ["origin/main", "fork/main", "main"]) {
    try {
      return runGit(["merge-base", candidate, "HEAD"]);
    } catch {
      // Try the next candidate.
    }
  }

  return "";
}

function listChangedDocs(base: string, head: string) {
  const args = ["diff", "--name-only", "--diff-filter=ACMR", base];
  if (head) {
    args.push(head);
  }
  args.push("--", "docs");

  return runGit(args)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => DOC_FILE_RE.test(line));
}

function loadGlossarySources() {
  const data = fs.readFileSync(GLOSSARY_PATH, "utf8");
  const entries: unknown = JSON.parse(data);
  if (!Array.isArray(entries)) {
    throw new Error(`${GLOSSARY_PATH} must contain an array`);
  }
  return new Set(
    entries
      .map((entry) =>
        entry && typeof entry === "object" && "source" in entry ? String(entry.source).trim() : "",
      )
      .filter(Boolean),
  );
}

function containsLatin(text: string) {
  return /[A-Za-z]/.test(text);
}

function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function unquoteScalar(raw: string) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isGlossaryCandidate(term: string, maxWords: number) {
  if (!term) {
    return false;
  }
  if (!containsLatin(term)) {
    return false;
  }
  if (term.includes("`")) {
    return false;
  }
  if (term.length > MAX_TERM_LENGTH) {
    return false;
  }
  return wordCount(term) <= maxWords;
}

function readGitFile(base: string, relPath: string) {
  try {
    return runGit(["show", `${base}:${relPath}`]);
  } catch {
    return "";
  }
}

function extractTerms(file: string, text: string) {
  const terms = new Map<string, TermMatch>();
  const lines = text.split("\n");

  if (lines[0]?.trim() === "---") {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line?.trim() === "---") {
        break;
      }

      const match = line?.match(/^title:\s*(.+)\s*$/);
      if (!match) {
        continue;
      }

      const title = unquoteScalar(match[1] ?? "");
      if (isGlossaryCandidate(title, MAX_TITLE_WORDS)) {
        terms.set(title, { file, line: index + 1, kind: "title", term: title });
      }
      break;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(LIST_ITEM_LINK_RE);
    if (!match) {
      continue;
    }

    const label = (match[1] ?? "").trim();
    if (!isGlossaryCandidate(label, MAX_LABEL_WORDS)) {
      continue;
    }

    if (!terms.has(label)) {
      terms.set(label, { file, line: index + 1, kind: "link label", term: label });
    }
  }

  return terms;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = resolveBase(args.base);

  if (!base) {
    console.warn(
      "docs:check-i18n-glossary: no merge base found; skipping glossary coverage check.",
    );
    process.exit(0);
  }

  const changedDocs = listChangedDocs(base, args.head);
  if (changedDocs.length === 0) {
    process.exit(0);
  }

  const glossary = loadGlossarySources();
  const missing: TermMatch[] = [];

  for (const relPath of changedDocs) {
    const absPath = path.join(ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }

    const currentTerms = extractTerms(relPath, fs.readFileSync(absPath, "utf8"));
    const baseTerms = extractTerms(relPath, readGitFile(base, relPath));

    for (const [term, match] of currentTerms) {
      if (baseTerms.has(term)) {
        continue;
      }
      if (glossary.has(term)) {
        continue;
      }
      missing.push(match);
    }
  }

  if (missing.length === 0) {
    process.exit(0);
  }

  console.error("docs:check-i18n-glossary: missing zh-CN glossary entries for changed doc labels:");
  for (const match of missing) {
    console.error(`- ${match.file}:${match.line} ${match.kind} "${match.term}"`);
  }
  console.error("");
  console.error(
    "Add exact source terms to docs/.i18n/glossary.zh-CN.json before rerunning docs-i18n.",
  );
  console.error(`Checked changed English docs relative to ${base}.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
