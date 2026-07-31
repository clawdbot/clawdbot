#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isChangedLaneTestPath } from "./changed-lanes.mjs";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { runAsScript } from "./lib/ts-guard-utils.mjs";

const DEFAULT_BASE_REF = "origin/main";
const DEFAULT_HEAD_REF = "HEAD";
const TEMP_DIR_HELPER_PATH = "test/helpers/temp-dir.ts";
const TEMP_DIR_HELPER_TEST_PATH = "test/helpers/temp-dir.test.ts";
const MANUAL_TEMP_DIR_HELPERS = new Set(["cleanupTempDirs", "createTempDirTracker", "makeTempDir"]);
const FINDING_PATTERNS = [
  {
    pattern: /\bmkdtemp(?:Sync)?\s*\(/u,
    reason: "new mkdtemp temp directory creation",
  },
  {
    pattern: /\btmp\s*\.\s*dir(?:Sync)?\s*\(/u,
    reason: "new tmp.dir temp directory creation",
  },
];
const TEMP_DIR_ALLOW_COMMENT_RE =
  /(?:^|\s)(?:\/\/|\/\*|\*|#)\s*openclaw-temp-dir:\s*allow\s+(.+)$/u;

function usage() {
  return `Usage: node scripts/report-test-temp-creations.mjs [options]

Description:
  Reports new test temp-directory migration warnings in added diff lines.
  This is a low-noise migration aid, not a cleanup data-flow checker. It does
  not scan existing lines for bare temp dirs and does not decide whether cleanup is sufficient.
  Add "openclaw-temp-dir: allow <reason>" in a same-line or immediately
  preceding added comment when a test intentionally needs bare temp creation.
  File scope intentionally reuses scripts/changed-lanes.mjs test-path
  classification instead of maintaining a separate test-helper heuristic.

Options:
  --base <ref>       Base ref for branch diffs. Default: ${DEFAULT_BASE_REF}
  --head <ref>       Head ref for branch diffs. Default: ${DEFAULT_HEAD_REF}
  --no-merge-base    Use a two-dot base..head diff for shallow CI checkouts.
  --staged           Inspect staged changes instead of a branch diff.
  --json             Print JSON findings to stdout.
  --fail-on-findings Exit 1 when findings are present. Default is report-only.
  -h, --help         Show this help.

Outputs:
  Human mode prints findings to stderr and exits 0 unless --fail-on-findings is set.
  GitHub Actions mode prints warning annotations and exits 0 unless --fail-on-findings is set.
  JSON mode prints an array of { file, line, reason, source } to stdout.

Examples:
  node scripts/report-test-temp-creations.mjs --base origin/main --head HEAD
  node scripts/report-test-temp-creations.mjs --staged --json
`;
}

function normalizePath(filePath) {
  return String(filePath ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function shouldInspectFile(filePath) {
  const normalizedPath = normalizePath(filePath);
  return normalizedPath !== TEMP_DIR_HELPER_PATH && isChangedLaneTestPath(normalizedPath);
}

function shouldInspectManualHelperUsage(filePath) {
  const normalizedPath = normalizePath(filePath);
  return normalizedPath !== TEMP_DIR_HELPER_TEST_PATH && shouldInspectFile(normalizedPath);
}

function isTruthyEnvFlag(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

function escapeGithubCommandValue(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeGithubCommandProperty(value) {
  return escapeGithubCommandValue(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function hasTempDirAllowMarker(source) {
  const reason = source.match(TEMP_DIR_ALLOW_COMMENT_RE)?.[1]?.trim() ?? "";
  return reason.length > 0;
}

function isTempDirAllowComment(source) {
  const trimmed = source.trim();
  return /^(?:\/\/|\/\*|\*|#)/u.test(trimmed) && hasTempDirAllowMarker(trimmed);
}

export function formatGithubWarning(finding) {
  const file = escapeGithubCommandProperty(finding.file);
  const line = escapeGithubCommandProperty(finding.line);
  const message = escapeGithubCommandValue(
    `${finding.reason}: prefer useAutoCleanupTempDirTracker(afterEach) from test/helpers/temp-dir.ts for new test-owned temp directories.`,
  );
  return `::warning file=${file},line=${line}::${message}`;
}

function parseArgs(argv) {
  const args = {
    base: DEFAULT_BASE_REF,
    failOnFindings: false,
    head: DEFAULT_HEAD_REF,
    help: false,
    json: false,
    noMergeBase: false,
    staged: false,
  };
  return parseFlagArgs(argv, args, [
    stringFlag("--base", "base"),
    booleanFlag("--fail-on-findings", "failOnFindings"),
    stringFlag("--head", "head"),
    booleanFlag("-h", "help"),
    booleanFlag("--help", "help"),
    booleanFlag("--json", "json"),
    booleanFlag("--no-merge-base", "noMergeBase"),
    booleanFlag("--staged", "staged"),
  ]);
}

function readDiff(args, cwd = process.cwd()) {
  let useMergeBase = !args.noMergeBase;
  if (useMergeBase && !args.staged) {
    const mergeBase = spawnSync("git", ["merge-base", args.base, args.head], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (mergeBase.error) {
      throw mergeBase.error;
    }
    if (mergeBase.status === 1) {
      // Delegated CI syncs can contain both refs without their shared history.
      // Compare the endpoint trees so this warning-only report still runs.
      useMergeBase = false;
    } else if (mergeBase.status !== 0) {
      throw new Error(mergeBase.stderr.trim() || "git merge-base failed");
    }
  }
  const range = useMergeBase ? `${args.base}...${args.head}` : `${args.base}..${args.head}`;
  const diffArgs = args.staged
    ? ["diff", "--cached", "--unified=0", "--diff-filter=ACMR", "--"]
    : ["diff", "--unified=0", "--diff-filter=ACMR", range, "--"];
  return execFileSync("git", diffArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readWorktreeSource(filePath, cwd) {
  try {
    return fs.readFileSync(path.join(cwd, filePath), "utf8");
  } catch {
    return "";
  }
}

function readStagedSource(filePath, cwd) {
  try {
    return execFileSync("git", ["show", `:${filePath}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function readSourceForDiff(filePath, args, cwd) {
  // Staged checks must parse the index blob. Reading the worktree mixes in
  // unstaged edits and can warn on code that will not be committed.
  return args.staged ? readStagedSource(filePath, cwd) : readWorktreeSource(filePath, cwd);
}

function stripKnownExtension(filePath) {
  return filePath.replace(/\.(?:c|m)?[jt]sx?$/u, "");
}

function isTempDirHelperImportSpec(filePath, specifier) {
  const normalizedSpecifier = normalizePath(specifier);
  const resolvedPath = normalizedSpecifier.startsWith(".")
    ? path.posix.normalize(path.posix.join(path.posix.dirname(filePath), normalizedSpecifier))
    : normalizedSpecifier;
  return stripKnownExtension(resolvedPath) === stripKnownExtension(TEMP_DIR_HELPER_PATH);
}

function createSourceFile(filePath, sourceText) {
  return ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
}

function lineForNode(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function sourceLineText(sourceFile, line) {
  const lineStarts = sourceFile.getLineStarts();
  const start = lineStarts[line - 1] ?? 0;
  const end = lineStarts[line] ?? sourceFile.text.length;
  return sourceFile.text.slice(start, end).trim();
}

function nodeOverlapsAddedLine(sourceFile, node, addedLineNumbers) {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  for (let line = startLine; line <= endLine; line += 1) {
    if (addedLineNumbers.has(line)) {
      return true;
    }
  }
  return false;
}

function normalizeFileTextMap(fileTextByPath) {
  if (!fileTextByPath) {
    return null;
  }
  if (fileTextByPath instanceof Map) {
    return fileTextByPath;
  }
  return new Map(Object.entries(fileTextByPath));
}

function readCurrentSource(filePath, options, fileTextByPath) {
  if (fileTextByPath?.has(filePath)) {
    return fileTextByPath.get(filePath) ?? "";
  }
  if (typeof options.readFile === "function") {
    return options.readFile(filePath) ?? "";
  }
  return "";
}

function collectManualTempDirHelperImports(sourceFile, filePath, addedLineNumbers = null) {
  const imports = [];
  const localNames = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isTempDirHelperImportSpec(filePath, statement.moduleSpecifier.text) ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    let importWarningLine = null;
    for (const element of statement.importClause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (!MANUAL_TEMP_DIR_HELPERS.has(imported)) {
        continue;
      }
      localNames.add(element.name.text);
      if (
        importWarningLine === null &&
        (!addedLineNumbers || nodeOverlapsAddedLine(sourceFile, element, addedLineNumbers))
      ) {
        importWarningLine = lineForNode(sourceFile, element);
      }
    }
    if (importWarningLine !== null) {
      imports.push({
        line: importWarningLine,
        source: statement.getText(sourceFile).trim().replace(/\s+/gu, " "),
      });
    }
  }
  return { imports, localNames };
}

function findManualHelperUsageFindings(filePath, sourceText, addedLines) {
  const addedLineNumbers = new Set(addedLines.map((line) => line.line));
  const sourceFile = createSourceFile(filePath, sourceText);
  const { imports, localNames } = collectManualTempDirHelperImports(
    sourceFile,
    filePath,
    addedLineNumbers,
  );
  const findings = imports.map((manualImport) => ({
    file: filePath,
    line: manualImport.line,
    reason: "new manual temp-dir helper import",
    source: manualImport.source,
  }));
  if (localNames.size === 0) {
    return findings;
  }
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      localNames.has(node.expression.text) &&
      nodeOverlapsAddedLine(sourceFile, node.expression, addedLineNumbers)
    ) {
      findings.push({
        file: filePath,
        line: lineForNode(sourceFile, node.expression),
        reason: "new manual temp-dir helper usage",
        source: sourceLineText(sourceFile, lineForNode(sourceFile, node.expression)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function collectAddedLinesByFile(diffText) {
  const addedLinesByFile = new Map();
  let currentFile = null;
  let currentLine = 0;

  for (const line of diffText.split(/\r?\n/u)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/u);
    if (fileMatch) {
      currentFile = normalizePath(fileMatch[1]);
      continue;
    }
    if (line === "+++ /dev/null") {
      currentFile = null;
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunkMatch) {
      currentLine = Number.parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentFile && shouldInspectFile(currentFile)) {
        const lines = addedLinesByFile.get(currentFile) ?? [];
        lines.push({ line: currentLine, source: line.slice(1) });
        addedLinesByFile.set(currentFile, lines);
      }
      currentLine += 1;
      continue;
    }

    if (line.startsWith(" ") || line === "") {
      currentLine += 1;
    }
  }

  return addedLinesByFile;
}

export function collectTempCreationFindingsFromDiff(diffText, options = {}) {
  const findings = [];
  const addedLinesByFile = collectAddedLinesByFile(diffText);
  const fileTextByPath = normalizeFileTextMap(options.fileTextByPath);
  let currentFile = null;
  let currentLine = 0;
  let allowNextLine = null;

  for (const line of diffText.split(/\r?\n/u)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/u);
    if (fileMatch) {
      currentFile = normalizePath(fileMatch[1]);
      allowNextLine = null;
      continue;
    }
    if (line === "+++ /dev/null") {
      currentFile = null;
      allowNextLine = null;
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunkMatch) {
      currentLine = Number.parseInt(hunkMatch[1], 10);
      allowNextLine = null;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (currentFile && shouldInspectFile(currentFile)) {
        const source = line.slice(1);
        const allowed =
          hasTempDirAllowMarker(source) ||
          (allowNextLine?.file === currentFile && allowNextLine.line === currentLine);
        for (const { pattern, reason } of FINDING_PATTERNS) {
          if (pattern.test(source)) {
            if (!allowed) {
              findings.push({
                file: currentFile,
                line: currentLine,
                reason,
                source: source.trim(),
              });
            }
            break;
          }
        }
        allowNextLine = isTempDirAllowComment(source)
          ? { file: currentFile, line: currentLine + 1 }
          : null;
      }
      currentLine += 1;
      continue;
    }

    if (line.startsWith(" ") || line === "") {
      allowNextLine = null;
      currentLine += 1;
    }
  }

  for (const [file, addedLines] of addedLinesByFile) {
    if (!shouldInspectManualHelperUsage(file)) {
      continue;
    }
    const sourceText = readCurrentSource(file, options, fileTextByPath);
    if (!sourceText) {
      continue;
    }
    findings.push(...findManualHelperUsageFindings(file, sourceText, addedLines));
  }

  return findings;
}

async function main(argv, io) {
  const args = parseArgs(argv ?? process.argv.slice(2));
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;
  const env = io?.env ?? process.env;
  if (args.help) {
    stdout.write(usage());
    return 0;
  }

  const cwd = process.cwd();
  const findings = collectTempCreationFindingsFromDiff(readDiff(args, cwd), {
    readFile(filePath) {
      return readSourceForDiff(filePath, args, cwd);
    },
  });
  if (args.json) {
    stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else if (findings.length === 0) {
    stderr.write("No new test temp-directory migration warnings found.\n");
  } else if (isTruthyEnvFlag(env.GITHUB_ACTIONS)) {
    for (const finding of findings) {
      stderr.write(`${formatGithubWarning(finding)}\n`);
    }
  } else {
    stderr.write("New test temp-directory migration warnings:\n");
    for (const finding of findings) {
      stderr.write(`- ${finding.file}:${finding.line} ${finding.reason}: ${finding.source}\n`);
    }
    stderr.write(
      "Prefer useAutoCleanupTempDirTracker(afterEach) from test/helpers/temp-dir.ts for new test-owned temp directories.\n",
    );
  }

  return args.failOnFindings && findings.length > 0 ? 1 : 0;
}

runAsScript(import.meta.url, async (argv, io) => {
  const exitCode = await main(argv, io);
  if (!io) {
    process.exitCode = exitCode;
  }
  return exitCode;
});
