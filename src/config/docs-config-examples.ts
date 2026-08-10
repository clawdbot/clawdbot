import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import { validateConfigObjectRaw } from "./validation-core.js";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

export type DocsConfigFinding = {
  filePath: string;
  fenceStartLine: number;
  issuePath: string;
  message: string;
};

export type DocsConfigStats = {
  filesScanned: number;
  fencesSeen: number;
  candidatesValidated: number;
  fencesSkipped: number;
  skippedUnsupportedLanguage: number;
  skippedOptOut: number;
  skippedParseFailure: number;
  skippedNonObject: number;
  skippedFragment: number;
};

export type DocsConfigAudit = {
  findings: DocsConfigFinding[];
  stats: DocsConfigStats;
};

type MarkdownFence = {
  info: string;
  body: string;
  startLine: number;
};

const ROOT_CONFIG_KEYS = new Set(Object.keys(OpenClawSchemaShape));

function emptyStats(filesScanned = 0): DocsConfigStats {
  return {
    filesScanned,
    fencesSeen: 0,
    candidatesValidated: 0,
    fencesSkipped: 0,
    skippedUnsupportedLanguage: 0,
    skippedOptOut: 0,
    skippedParseFailure: 0,
    skippedNonObject: 0,
    skippedFragment: 0,
  };
}

function extractMarkdownFences(markdown: string): MarkdownFence[] {
  const lines = markdown.split(/\r?\n/u);
  const fences: MarkdownFence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]?.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!opening) {
      continue;
    }
    const marker = opening[1];
    if (!marker) {
      continue;
    }
    const body: string[] = [];
    const startLine = index + 1;
    const closing = new RegExp(`^ {0,3}${marker}[ \\t]*$`, "u");
    index += 1;
    while (index < lines.length && !closing.test(lines[index] ?? "")) {
      body.push(lines[index] ?? "");
      index += 1;
    }
    fences.push({
      info: opening[2]?.trim() ?? "",
      body: body.join("\n"),
      startLine,
    });
  }
  return fences;
}

function isConfigFence(info: string): boolean {
  return /^(?:json5|json|jsonc)(?:\s|$)/iu.test(info);
}

function isUnrecognizedKeyMessage(message: string): boolean {
  return /(?:Unrecognized keys?|must not have additional properties):\s*"/iu.test(message);
}

function isWholeConfig(parsed: Record<string, unknown>): boolean {
  const topLevelKeys = Object.keys(parsed);
  const recognizedKeys = topLevelKeys.filter((key) => ROOT_CONFIG_KEYS.has(key));
  // Accepted tradeoff: equal config/non-config mixes and documents containing only
  // retired root keys look like fragments and are skipped.
  return recognizedKeys.length > topLevelKeys.length / 2;
}

function stripIncludeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripIncludeKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  // src/config/includes.ts resolves these directives before schema validation.
  // Docs validation drops them recursively to mirror that pipeline boundary.
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "$include" ? [] : [[key, stripIncludeKeys(child)]],
    ),
  );
}

/** Audits one Markdown document without filesystem fixtures. */
export function auditConfigMarkdown(params: {
  markdown: string;
  filePath: string;
}): DocsConfigAudit {
  const findings: DocsConfigFinding[] = [];
  const stats = emptyStats(1);

  for (const fence of extractMarkdownFences(params.markdown)) {
    stats.fencesSeen += 1;
    if (!isConfigFence(fence.info)) {
      stats.fencesSkipped += 1;
      stats.skippedUnsupportedLanguage += 1;
      continue;
    }
    if (/\bvalidate=false\b/iu.test(fence.info)) {
      stats.fencesSkipped += 1;
      stats.skippedOptOut += 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON5.parse(fence.body);
    } catch {
      stats.fencesSkipped += 1;
      stats.skippedParseFailure += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      stats.fencesSkipped += 1;
      stats.skippedNonObject += 1;
      continue;
    }
    if (!isWholeConfig(parsed)) {
      stats.fencesSkipped += 1;
      stats.skippedFragment += 1;
      continue;
    }

    const result = validateConfigObjectRaw(stripIncludeKeys(parsed), {
      validateBundledChannels: true,
    });
    stats.candidatesValidated += 1;
    if (result.ok) {
      continue;
    }
    // This gate catches retired keys only. Placeholder type errors and incomplete
    // illustrative values remain outside its contract.
    for (const issue of result.issues) {
      if (!isUnrecognizedKeyMessage(issue.message)) {
        continue;
      }
      findings.push({
        filePath: params.filePath,
        fenceStartLine: fence.startLine,
        issuePath: issue.path,
        message: issue.message,
      });
    }
  }

  return {
    findings: findings.toSorted(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) ||
        left.fenceStartLine - right.fenceStartLine ||
        left.issuePath.localeCompare(right.issuePath),
    ),
    stats,
  };
}

// Keep this in sync with the generated-doc locale test in scripts/docs-link-audit.mts.
function isLocalizedDocPath(filePath: string): boolean {
  return /^\/?[a-z]{2}(?:-[A-Za-z]{2,8})+\//u.test(filePath);
}

function listDocsFiles(docsRoot: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && /\.mdx?$/iu.test(entry.name)) {
        files.push(entryPath);
      }
    }
  };
  walk(docsRoot);
  return files.toSorted((left, right) => left.localeCompare(right));
}

/** Audits English docs config examples against the current strict schema. */
export function auditDocsConfigExamples(params: { repoRoot: string }): DocsConfigAudit {
  const docsRoot = path.join(params.repoRoot, "docs");
  const findings: DocsConfigFinding[] = [];
  const stats = emptyStats();

  for (const filePath of listDocsFiles(docsRoot)) {
    const docsRelativePath = path.relative(docsRoot, filePath).split(path.sep).join("/");
    if (isLocalizedDocPath(docsRelativePath)) {
      continue;
    }
    const repoRelativePath = path.posix.join("docs", docsRelativePath);
    const audit = auditConfigMarkdown({
      markdown: fs.readFileSync(filePath, "utf8"),
      filePath: repoRelativePath,
    });
    findings.push(...audit.findings);
    for (const [key, value] of Object.entries(audit.stats)) {
      stats[key as keyof DocsConfigStats] += value;
    }
  }

  return { findings, stats };
}
