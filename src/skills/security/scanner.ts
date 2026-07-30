// Skill security scanner inspects skill files and manifests for unsafe patterns.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasErrnoCode } from "../../infra/errors.js";
import { isPathInside } from "../../security/scan-paths.js";
import { formatScanEvidence, LITERAL_SECRET_SKILL_CONTENT_RULE } from "./scan-evidence.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillScanSeverity = "info" | "warn" | "critical";

export type SkillScanFinding = {
  ruleId: string;
  severity: SkillScanSeverity;
  file: string;
  line: number;
  message: string;
  evidence: string;
};

type SkillScanSummary = {
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  truncated: boolean;
  findings: SkillScanFinding[];
};

export type SkillScanOptions = {
  excludeTestFiles?: boolean;
  includeHiddenDirectories?: boolean;
  includeNestedNodeModulesTestFiles?: boolean;
  includeNodeModules?: boolean;
  includeFiles?: string[];
  onlyIncludeFiles?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
};

// ---------------------------------------------------------------------------
// Scannable extensions
// ---------------------------------------------------------------------------

const SCANNABLE_EXTENSIONS = new Set([
  ".js",
  ".ts",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
]);

const DEFAULT_MAX_SCAN_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_RULE_FINDINGS_PER_RULE = 32;
const FILE_SCAN_CACHE_MAX = 5000;
const DIR_ENTRY_CACHE_MAX = 5000;
const TEST_DIRECTORY_NAMES = new Set(["__fixtures__", "__mocks__", "__tests__", "test", "tests"]);
const TEST_FILE_NAME_PATTERN = /\.(?:mock|spec|test)\.[^.]+$/i;

type FileScanCacheEntry = {
  size: number;
  mtimeMs: number;
  maxFileBytes: number;
  scanned: boolean;
  findings: SkillScanFinding[];
};

const FILE_SCAN_CACHE = new Map<string, FileScanCacheEntry>();
type CachedDirEntry = {
  name: string;
  kind: "file" | "dir";
};
type CollectedScannableFiles = {
  files: string[];
  truncated: boolean;
};
type DirEntryCacheEntry = {
  mtimeMs: number;
  entries: CachedDirEntry[];
};
const DIR_ENTRY_CACHE = new Map<string, DirEntryCacheEntry>();

export function isScannable(filePath: string): boolean {
  return SCANNABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function getCachedFileScanResult(params: {
  filePath: string;
  size: number;
  mtimeMs: number;
  maxFileBytes: number;
}): FileScanCacheEntry | undefined {
  const cached = FILE_SCAN_CACHE.get(params.filePath);
  if (!cached) {
    return undefined;
  }
  if (
    cached.size !== params.size ||
    cached.mtimeMs !== params.mtimeMs ||
    cached.maxFileBytes !== params.maxFileBytes
  ) {
    FILE_SCAN_CACHE.delete(params.filePath);
    return undefined;
  }
  return cached;
}

function setCachedFileScanResult(filePath: string, entry: FileScanCacheEntry): void {
  if (FILE_SCAN_CACHE.size >= FILE_SCAN_CACHE_MAX) {
    const oldest = FILE_SCAN_CACHE.keys().next();
    if (!oldest.done) {
      FILE_SCAN_CACHE.delete(oldest.value);
    }
  }
  FILE_SCAN_CACHE.set(filePath, entry);
}

function setCachedDirEntries(dirPath: string, entry: DirEntryCacheEntry): void {
  if (DIR_ENTRY_CACHE.size >= DIR_ENTRY_CACHE_MAX) {
    const oldest = DIR_ENTRY_CACHE.keys().next();
    if (!oldest.done) {
      DIR_ENTRY_CACHE.delete(oldest.value);
    }
  }
  DIR_ENTRY_CACHE.set(dirPath, entry);
}

export function clearSkillScanCacheForTest(): void {
  FILE_SCAN_CACHE.clear();
  DIR_ENTRY_CACHE.clear();
}

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

type LineRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  pattern: RegExp;
  /** If set, the rule only fires when the *full source* also matches this pattern. */
  requiresContext?: RegExp;
};

type SourceRule = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  /** Primary pattern tested against the full source. */
  pattern: RegExp;
  /** Secondary context pattern; both must match for the rule to fire. */
  requiresContext?: RegExp;
  /** If set, secondary context must be within this many lines of the primary match. */
  requiresContextWindowLines?: number;
};

const LINE_RULES: LineRule[] = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    // Group 1: bare call (exec(...)). Group 2: computed member (obj["exec"](...)),
    // with quotes stripped so isBenignMemberExecMatch sees the bare command.
    pattern:
      /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(|["'](exec|execSync|spawn|spawnSync|execFile|execFileSync)["']\s*\]\s*\(/,
    requiresContext: /child_process/,
  },
  {
    ruleId: "dynamic-code-execution",
    severity: "critical",
    message: "Dynamic code execution detected",
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    ruleId: "crypto-mining",
    severity: "critical",
    message: "Possible crypto-mining reference detected",
    pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i,
  },
  {
    ruleId: "suspicious-network",
    severity: "warn",
    message: "WebSocket connection to non-standard port",
    pattern: /new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/,
  },
];

const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);
const NETWORK_SEND_CONTEXT_PATTERN = /\bfetch\s*\(|\bpost\s*\(|\.\s*post\s*\(|http\.request\s*\(/i;

const SOURCE_RULES: SourceRule[] = [
  {
    ruleId: "potential-exfiltration",
    severity: "warn",
    message: "File read combined with network send — possible data exfiltration",
    pattern: /readFileSync|readFile/,
    requiresContext: NETWORK_SEND_CONTEXT_PATTERN,
  },
  {
    ruleId: "obfuscated-code",
    severity: "warn",
    message: "Hex-encoded string sequence detected (possible obfuscation)",
    pattern: /(\\x[0-9a-fA-F]{2}){6,}/,
  },
  {
    ruleId: "obfuscated-code",
    severity: "warn",
    message: "Large base64 payload with decode call detected (possible obfuscation)",
    pattern: /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/,
  },
  {
    ruleId: "env-harvesting",
    severity: "critical",
    message:
      "Environment variable access combined with network send — possible credential harvesting",
    pattern: /process\.env/,
    requiresContext: NETWORK_SEND_CONTEXT_PATTERN,
    requiresContextWindowLines: 8,
  },
];

const SKILL_CONTENT_RULES: SourceRule[] = [
  LITERAL_SECRET_SKILL_CONTENT_RULE,
  {
    ruleId: "prompt-injection-ignore-instructions",
    severity: "critical",
    message: "Prompt-injection wording attempts to override higher-priority instructions",
    pattern: /ignore (all|any|previous|above|prior) instructions/i,
  },
  {
    ruleId: "prompt-injection-system",
    severity: "critical",
    message: "Skill text references hidden prompt layers",
    pattern: /\b(system prompt|developer message|hidden instructions)\b/i,
  },
  {
    ruleId: "prompt-injection-tool",
    severity: "critical",
    message: "Skill text encourages bypassing tool approval",
    pattern:
      /\b(run|execute|invoke|call)\b.{0,50}\btool\b.{0,50}\bwithout\b.{0,30}\b(permission|approval)/i,
  },
  {
    ruleId: "shell-pipe-to-shell",
    severity: "critical",
    message: "Skill text includes pipe-to-shell install pattern",
    pattern: /\b(curl|wget)\b[^|\n]{0,120}\|\s*(sh|bash|zsh)\b/i,
  },
  {
    ruleId: "secret-exfiltration",
    severity: "critical",
    message: "Skill text may exfiltrate environment variables",
    pattern: /\b(process\.env|env)\b.{0,80}\b(fetch|curl|wget|http|https)\b/i,
  },
  {
    ruleId: "destructive-delete",
    severity: "warn",
    message: "Skill text contains broad destructive delete command",
    pattern: /\brm\s+-rf\s+(\/|\$HOME|~|\.)/i,
  },
  {
    ruleId: "unsafe-permissions",
    severity: "warn",
    message: "Skill text contains unsafe permission change",
    pattern: /\bchmod\s+(-R\s+)?777\b/i,
  },
];

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

function isBenignMemberExecMatch(line: string, match: RegExpExecArray): boolean {
  // Group 1 is the bare-call command; group 2 is the computed-member command.
  const command = match[1] ?? match[2];
  if (command !== "exec") {
    return false;
  }

  if (match[1] !== undefined) {
    // Bare form: only `.exec(` (e.g. RegExp.exec) is benign, unless the object
    // is a known child_process namespace.
    const matchIndex = match.index;
    if (matchIndex <= 0 || line[matchIndex - 1] !== ".") {
      return false;
    }
    return !/\b(?:cp|childProcess|child_process)\s*\.\s*exec\s*\(/.test(line);
  }

  // Computed form `["exec"](`: benign unless the object is a known
  // child_process namespace. This preserves the RegExp.exec-style benign
  // behavior for `someObj["exec"](` while still catching `cp["exec"](`.
  return !/\b(?:cp|childProcess|child_process)\s*\[\s*["']exec["']\s*\]\s*\(/.test(line);
}

const DANGEROUS_EXEC_METHODS = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);

const EMPTY_ALIAS_MAP = new Map<string, string>();

// Matches `import { ... } from "child_process"` (ESM) or
// `{ ... } = require("child_process")` (CJS) and collects `original -> alias`
// bindings for dangerous exec methods. Only bindings sourced from
// child_process are tracked, so an unrelated `launch(` in a file that also
// imports child_process for something else does not false-positive.
const CHILD_PROCESS_IMPORT_PATTERN =
  /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/;
const CHILD_PROCESS_REQUIRE_PATTERN =
  /\{\s*([^}]*)\s*\}\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/;
const ESM_ALIAS_PATTERN = /\b(\w+)\s+as\s+(\w+)/g;
const CJS_ALIAS_PATTERN = /\b(\w+)\s*:\s*(\w+)/g;

function collectChildProcessAliases(lines: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const line of lines) {
    const importMatch = CHILD_PROCESS_IMPORT_PATTERN.exec(line);
    const requireMatch = !importMatch ? CHILD_PROCESS_REQUIRE_PATTERN.exec(line) : null;
    const bindingList = importMatch?.[1] ?? requireMatch?.[1];
    if (bindingList === undefined) {
      continue;
    }
    const aliasPattern = importMatch ? ESM_ALIAS_PATTERN : CJS_ALIAS_PATTERN;
    aliasPattern.lastIndex = 0;
    let aliasMatch: RegExpExecArray | null;
    while ((aliasMatch = aliasPattern.exec(bindingList)) !== null) {
      // ESM: group1=original, group2=alias. CJS: group1=original, group2=alias.
      const original = aliasMatch[1];
      const alias = aliasMatch[2];
      if (original !== undefined && alias !== undefined && DANGEROUS_EXEC_METHODS.has(original)) {
        aliases.set(alias, original);
      }
    }
  }
  return aliases;
}

function matchChildProcessAliasCall(line: string, aliases: Map<string, string>): boolean {
  for (const alias of aliases.keys()) {
    if (new RegExp(`\\b${alias}\\s*\\(`).test(line)) {
      return true;
    }
  }
  return false;
}

function stripCommentsForHeuristics(source: string): string {
  let stripped = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        stripped += "\n";
      }
      continue;
    }

    if (quote) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      stripped += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      if (source[i] === "\n") {
        stripped += "\n";
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    stripped += ch;
  }

  return stripped;
}

function findSourceRuleMatch(params: {
  rule: SourceRule;
  source: string;
  lines: string[];
}): { line: number; evidence: string } | null {
  if (!params.rule.pattern.test(params.source)) {
    return null;
  }
  if (params.rule.requiresContext && !params.rule.requiresContext.test(params.source)) {
    return null;
  }

  for (let i = 0; i < params.lines.length; i++) {
    if (!params.rule.pattern.test(params.lines[i] ?? "")) {
      continue;
    }

    if (params.rule.requiresContext && params.rule.requiresContextWindowLines !== undefined) {
      const start = Math.max(0, i - params.rule.requiresContextWindowLines);
      const end = Math.min(params.lines.length, i + params.rule.requiresContextWindowLines + 1);
      const windowSource = params.lines.slice(start, end).join("\n");
      if (!params.rule.requiresContext.test(windowSource)) {
        continue;
      }
    }

    return { line: i + 1, evidence: params.lines[i] ?? "" };
  }

  if (params.rule.requiresContextWindowLines !== undefined) {
    return null;
  }

  return { line: 1, evidence: truncateUtf16Safe(params.source, 120) };
}

export function scanSource(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const heuristicSource = stripCommentsForHeuristics(source);
  const heuristicLines = heuristicSource.split("\n");

  // --- Line rules ---
  for (const rule of LINE_RULES) {
    // Skip rule entirely if context requirement not met
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    // For dangerous-exec, track child_process import/require aliases so calls
    // made through a renamed binding (e.g. `import { spawn as launch }`) are
    // still flagged. Built once per rule; the requiresContext gate above
    // guarantees child_process is present whenever aliases can exist.
    const childProcessAliases =
      rule.ruleId === "dangerous-exec" ? collectChildProcessAliases(lines) : EMPTY_ALIAS_MAP;

    let acceptedMatches = 0;
    let omittedMatches = 0;
    let lastOmittedLine: number | undefined;
    for (const [i, line] of lines.entries()) {
      const matches = line.matchAll(
        new RegExp(
          rule.pattern.source,
          rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
        ),
      );
      let matchedOnLine = false;
      for (const match of matches) {
        if (rule.ruleId === "dangerous-exec" && isBenignMemberExecMatch(line, match)) {
          continue;
        }

        // Special handling for suspicious-network: check port
        if (rule.ruleId === "suspicious-network") {
          const port = Number.parseInt(expectDefined(match[1], "scanner regex capture 1"), 10);
          if (STANDARD_PORTS.has(port)) {
            continue;
          }
        }

        matchedOnLine = true;
        if (acceptedMatches >= MAX_LINE_RULE_FINDINGS_PER_RULE) {
          omittedMatches += 1;
          lastOmittedLine = i + 1;
          continue;
        }

        // Retain distinct calls up to the cap, then aggregate every remaining match.
        // This keeps hostile output bounded without hiding that later sites exist.
        findings.push({
          ruleId: rule.ruleId,
          severity: rule.severity,
          file: filePath,
          line: i + 1,
          message: rule.message,
          evidence: formatScanEvidence(line),
        });
        acceptedMatches += 1;
      }

      // No direct pattern match on this line: still catch child_process calls
      // made through a renamed binding (alias) that the bare-name pattern
      // cannot see. Only applies to dangerous-exec with collected aliases.
      if (
        !matchedOnLine &&
        rule.ruleId === "dangerous-exec" &&
        childProcessAliases.size > 0 &&
        matchChildProcessAliasCall(line, childProcessAliases)
      ) {
        if (acceptedMatches >= MAX_LINE_RULE_FINDINGS_PER_RULE) {
          omittedMatches += 1;
          lastOmittedLine = i + 1;
        } else {
          findings.push({
            ruleId: rule.ruleId,
            severity: rule.severity,
            file: filePath,
            line: i + 1,
            message: rule.message,
            evidence: formatScanEvidence(line),
          });
          acceptedMatches += 1;
        }
      }
    }
    if (lastOmittedLine !== undefined) {
      findings.push({
        ruleId: `${rule.ruleId}-truncated`,
        severity: rule.severity,
        file: filePath,
        line: lastOmittedLine,
        message: `${omittedMatches} additional ${rule.ruleId} matches omitted after ${MAX_LINE_RULE_FINDINGS_PER_RULE} findings`,
        evidence: `[${omittedMatches} additional matches omitted after ${MAX_LINE_RULE_FINDINGS_PER_RULE} findings]`,
      });
    }
  }

  // --- Source rules ---
  const matchedSourceRules = new Set<string>();
  for (const rule of SOURCE_RULES) {
    // Allow multiple findings for different messages with the same ruleId
    // but deduplicate exact (ruleId+message) combos
    const ruleKey = `${rule.ruleId}::${rule.message}`;
    if (matchedSourceRules.has(ruleKey)) {
      continue;
    }

    const match = findSourceRuleMatch({
      rule,
      source: heuristicSource,
      lines: heuristicLines,
    });
    if (!match) {
      continue;
    }

    findings.push({
      ruleId: rule.ruleId,
      severity: rule.severity,
      file: filePath,
      line: match.line,
      message: rule.message,
      evidence: formatScanEvidence(lines[match.line - 1] ?? match.evidence),
    });
    matchedSourceRules.add(ruleKey);
  }

  return findings;
}

export function scanSkillContent(content: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = content.split("\n");
  const matchedRules = new Set<string>();

  for (const rule of SKILL_CONTENT_RULES) {
    if (matchedRules.has(rule.ruleId)) {
      continue;
    }
    const match = findSourceRuleMatch({
      rule,
      source: content,
      lines,
    });
    if (!match) {
      continue;
    }
    findings.push({
      ruleId: rule.ruleId,
      severity: rule.severity,
      file: filePath,
      line: match.line,
      message: rule.message,
      // Scanner output is user-visible; redact the whole evidence line if any rule sees a key.
      evidence:
        rule.ruleId === "literal-secret"
          ? "[REDACTED CREDENTIAL]"
          : formatScanEvidence(lines[match.line - 1] ?? match.evidence),
    });
    matchedRules.add(rule.ruleId);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

function normalizeScanOptions(opts?: SkillScanOptions): Required<SkillScanOptions> {
  return {
    excludeTestFiles: opts?.excludeTestFiles ?? false,
    includeHiddenDirectories: opts?.includeHiddenDirectories ?? false,
    includeNestedNodeModulesTestFiles: opts?.includeNestedNodeModulesTestFiles ?? false,
    includeNodeModules: opts?.includeNodeModules ?? false,
    includeFiles: opts?.includeFiles ?? [],
    onlyIncludeFiles: opts?.onlyIncludeFiles ?? false,
    maxFiles: Math.max(1, opts?.maxFiles ?? DEFAULT_MAX_SCAN_FILES),
    maxFileBytes: Math.max(1, opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
  };
}

function isExcludedTestDirectoryName(name: string): boolean {
  return TEST_DIRECTORY_NAMES.has(name);
}

function isExcludedTestFileName(name: string): boolean {
  return TEST_FILE_NAME_PATTERN.test(name);
}

function pathContainsNodeModulesSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/u).includes("node_modules");
}

async function walkDirWithLimit(
  rootDir: string,
  dirPath: string,
  candidateLimit: number,
  excludeTestFiles: boolean,
  includeHiddenDirectories: boolean,
  includeNestedNodeModulesTestFiles: boolean,
  includeNodeModules: boolean,
): Promise<CollectedScannableFiles> {
  const files: string[] = [];
  const stack: string[] = [dirPath];

  while (stack.length > 0 && files.length < candidateLimit) {
    const currentDir = stack.pop();
    if (!currentDir) {
      break;
    }

    const entries = await readDirEntriesWithCache(currentDir);
    for (const entry of entries) {
      if (files.length >= candidateLimit) {
        break;
      }
      if (
        (!includeHiddenDirectories && entry.name.startsWith(".")) ||
        (!includeNodeModules && entry.name === "node_modules")
      ) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      const isExcludedTestPath =
        entry.kind === "dir"
          ? isExcludedTestDirectoryName(entry.name)
          : isExcludedTestFileName(entry.name);
      if (
        excludeTestFiles &&
        isExcludedTestPath &&
        !(
          includeNestedNodeModulesTestFiles &&
          pathContainsNodeModulesSegment(path.relative(rootDir, fullPath))
        )
      ) {
        continue;
      }
      if (entry.kind === "dir") {
        stack.push(fullPath);
      } else if (entry.kind === "file" && isScannable(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return { files, truncated: files.length >= candidateLimit };
}

async function readDirEntriesWithCache(dirPath: string): Promise<CachedDirEntry[]> {
  let st: Awaited<ReturnType<typeof fs.stat>> | null;
  try {
    st = await fs.stat(dirPath);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return [];
    }
    throw err;
  }
  if (!st?.isDirectory()) {
    return [];
  }

  const cached = DIR_ENTRY_CACHE.get(dirPath);
  if (cached && cached.mtimeMs === st.mtimeMs) {
    return cached.entries;
  }

  const dirents = await fs.readdir(dirPath, { withFileTypes: true });
  const entries: CachedDirEntry[] = [];
  for (const entry of dirents) {
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, kind: "dir" });
    } else if (entry.isFile()) {
      entries.push({ name: entry.name, kind: "file" });
    }
  }
  setCachedDirEntries(dirPath, {
    mtimeMs: st.mtimeMs,
    entries,
  });
  return entries;
}

async function resolveForcedFiles(params: {
  rootDir: string;
  includeFiles: string[];
}): Promise<string[]> {
  if (params.includeFiles.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const rawIncludePath of params.includeFiles) {
    const includePath = path.resolve(params.rootDir, rawIncludePath);
    if (!isPathInside(params.rootDir, includePath)) {
      continue;
    }
    if (!isScannable(includePath)) {
      continue;
    }
    if (seen.has(includePath)) {
      continue;
    }

    let st: Awaited<ReturnType<typeof fs.stat>> | null;
    try {
      st = await fs.stat(includePath);
    } catch (err) {
      if (hasErrnoCode(err, "ENOENT")) {
        continue;
      }
      throw err;
    }
    if (!st?.isFile()) {
      continue;
    }

    out.push(includePath);
    seen.add(includePath);
  }

  return out;
}

async function collectScannableFiles(
  dirPath: string,
  opts: Required<SkillScanOptions>,
): Promise<CollectedScannableFiles> {
  const forcedFiles = await resolveForcedFiles({
    rootDir: dirPath,
    includeFiles: opts.includeFiles,
  });
  if (opts.onlyIncludeFiles) {
    return {
      files: forcedFiles.slice(0, opts.maxFiles),
      truncated: forcedFiles.length > opts.maxFiles,
    };
  }
  if (forcedFiles.length > opts.maxFiles) {
    return { files: forcedFiles.slice(0, opts.maxFiles), truncated: true };
  }

  const walked = await walkDirWithLimit(
    dirPath,
    dirPath,
    opts.maxFiles + 1,
    opts.excludeTestFiles,
    opts.includeHiddenDirectories,
    opts.includeNestedNodeModulesTestFiles,
    opts.includeNodeModules,
  );
  const seen = new Set(forcedFiles.map((f) => path.resolve(f)));
  const out = [...forcedFiles];
  for (const walkedFile of walked.files) {
    const resolved = path.resolve(walkedFile);
    if (seen.has(resolved)) {
      continue;
    }
    if (out.length >= opts.maxFiles) {
      return { files: out.slice(0, opts.maxFiles), truncated: true };
    }
    out.push(walkedFile);
    seen.add(resolved);
  }
  return { files: out, truncated: false };
}

async function scanFileWithCache(params: {
  filePath: string;
  maxFileBytes: number;
}): Promise<{ scanned: boolean; findings: SkillScanFinding[] }> {
  const { filePath, maxFileBytes } = params;
  let st: Awaited<ReturnType<typeof fs.stat>> | null;
  try {
    st = await fs.stat(filePath);
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return { scanned: false, findings: [] };
    }
    throw err;
  }
  if (!st?.isFile()) {
    return { scanned: false, findings: [] };
  }
  const cached = getCachedFileScanResult({
    filePath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    maxFileBytes,
  });
  if (cached) {
    return {
      scanned: cached.scanned,
      findings: cached.findings,
    };
  }

  if (st.size > maxFileBytes) {
    const skippedEntry: FileScanCacheEntry = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      maxFileBytes,
      scanned: false,
      findings: [],
    };
    setCachedFileScanResult(filePath, skippedEntry);
    return { scanned: false, findings: [] };
  }

  let source: string;
  try {
    source = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (hasErrnoCode(err, "ENOENT")) {
      return { scanned: false, findings: [] };
    }
    throw err;
  }
  const findings = scanSource(source, filePath);
  setCachedFileScanResult(filePath, {
    size: st.size,
    mtimeMs: st.mtimeMs,
    maxFileBytes,
    scanned: true,
    findings,
  });
  return { scanned: true, findings };
}

export async function scanDirectoryWithSummary(
  dirPath: string,
  opts?: SkillScanOptions,
): Promise<SkillScanSummary> {
  const scanOptions = normalizeScanOptions(opts);
  const { files, truncated } = await collectScannableFiles(dirPath, scanOptions);
  const allFindings: SkillScanFinding[] = [];
  let scannedFiles = 0;
  let critical = 0;
  let warn = 0;
  let info = 0;

  for (const file of files) {
    const scanResult = await scanFileWithCache({
      filePath: file,
      maxFileBytes: scanOptions.maxFileBytes,
    });
    if (!scanResult.scanned) {
      continue;
    }
    scannedFiles += 1;
    for (const finding of scanResult.findings) {
      allFindings.push(finding);
      if (finding.severity === "critical") {
        critical += 1;
      } else if (finding.severity === "warn") {
        warn += 1;
      } else {
        info += 1;
      }
    }
  }

  return {
    scannedFiles,
    critical,
    warn,
    info,
    truncated,
    findings: allFindings,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
