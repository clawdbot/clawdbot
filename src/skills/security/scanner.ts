// Skill security scanner inspects skill files and manifests for unsafe patterns.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasErrnoCode } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
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
const TEST_FILE_NAME_PATTERN = /\.(?:mock|spec|test|test-helper|test-support)\.[^.]+$/i;

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
  pruneMapToMaxSize(FILE_SCAN_CACHE, FILE_SCAN_CACHE_MAX - 1);
  FILE_SCAN_CACHE.set(filePath, entry);
}

function setCachedDirEntries(dirPath: string, entry: DirEntryCacheEntry): void {
  pruneMapToMaxSize(DIR_ENTRY_CACHE, DIR_ENTRY_CACHE_MAX - 1);
  DIR_ENTRY_CACHE.set(dirPath, entry);
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
    // Two call shapes both expose the bare command name in a capture group
    // (group 1 for direct, group 2 for computed) so the downstream benign-member
    // filter can normalize via `match[1] ?? match[2]`:
    //   - direct:    exec(  |  cp.exec(  |  cp.spawn(
    //   - computed:  cp["spawn"](  |  proc["exec"](
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
    pattern: /\bignore\s+(?:(?:all|any)\s+)?(?:previous|above|prior|all|any)\s+instructions\b/i,
  },
  {
    ruleId: "prompt-injection-system",
    severity: "critical",
    message: "Skill text references hidden prompt layers",
    pattern: /\b(?:system\s+prompt|developer\s+message|hidden\s+instructions)\b/i,
  },
  {
    ruleId: "prompt-injection-tool",
    severity: "critical",
    message: "Skill text encourages bypassing tool approval",
    pattern:
      /\b(run|execute|invoke|call)\b[\s\S]{0,50}\btool\b[\s\S]{0,50}\bwithout\b[\s\S]{0,30}\b(permission|approval)/i,
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

// Methods exported by node:child_process that the dangerous-exec rule watches.
const CHILD_PROCESS_EXEC_METHODS = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);

/**
 * Provenance-aware child_process binding collection.
 *
 * The scanner is intentionally regex-based (no AST). This helper derives call
 * bindings ONLY from actual `child_process` imports/requires so that an
 * unrelated alias bound from another module (e.g. `import { spawn as launch }
 * from "./other"`) does not become a false positive — this is the issue's
 * "avoid source-wide token correlation false positives" constraint.
 *
 * Returns two views of the same provenance:
 * - `methodAliases`: renamed method bindings (`spawn -> launch`, `exec -> run`)
 * - `namespaceAliases`: whole-namespace bindings (`cp`, `proc`, …) used for
 *   both dot calls (`cp.exec()`) and computed calls (`proc["exec"]()`).
 */
type ChildProcessBindings = {
  methodAliases: Map<string, string>;
  namespaceAliases: Set<string>;
};

function collectChildProcessBindings(source: string): ChildProcessBindings {
  const methodAliases = new Map<string, string>();
  const namespaceAliases = new Set<string>();

  // ESM named imports: import { spawn as launch, execFile } from "child_process"
  const esmNamed = /\bimport\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
  // ESM default namespace: import cp from "child_process"
  const esmDefault = /\bimport\s+(\w+)\s+from\s*["'](?:node:)?child_process["']/g;
  // ESM namespace import: import * as proc from "child_process"
  const esmNamespace = /\bimport\s*\*\s*as\s+(\w+)\s+from\s*["'](?:node:)?child_process["']/g;
  // CJS destructured: const { exec: run, spawn } = require("child_process")
  const cjsDestructured =
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;
  // CJS namespace: const proc = require("child_process")
  const cjsNamespace =
    /\b(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/g;

  const collectSpecifiers = (specText: string): void => {
    for (const rawSpec of specText.split(",")) {
      const spec = rawSpec.trim();
      if (!spec) {
        continue;
      }
      // Renamed binding: `spawn as launch` (ESM) or `exec: run` (CJS)
      const asMatch = spec.match(/^(\w+)\s+(?:as)\s+(\w+)$/) ?? spec.match(/^(\w+)\s*:\s*(\w+)$/);
      if (asMatch?.[1] && asMatch[2]) {
        const original = asMatch[1];
        const alias = asMatch[2];
        if (CHILD_PROCESS_EXEC_METHODS.has(original)) {
          methodAliases.set(alias, original);
        }
      }
      // Bare imported method name (`execFile`) is already matched by the
      // literal pattern, so no alias entry is needed for it.
    }
  };

  let match: RegExpExecArray | null;
  while ((match = esmNamed.exec(source))) {
    collectSpecifiers(expectDefined(match[1], "child_process esm named import specifiers"));
  }
  while ((match = cjsDestructured.exec(source))) {
    collectSpecifiers(expectDefined(match[1], "child_process cjs destructured specifiers"));
  }
  while ((match = esmDefault.exec(source))) {
    namespaceAliases.add(expectDefined(match[1], "child_process esm default namespace"));
  }
  while ((match = esmNamespace.exec(source))) {
    namespaceAliases.add(expectDefined(match[1], "child_process esm namespace import"));
  }
  while ((match = cjsNamespace.exec(source))) {
    namespaceAliases.add(expectDefined(match[1], "child_process cjs namespace"));
  }

  return { methodAliases, namespaceAliases };
}

/**
 * Detects every call to a renamed child_process method alias on a single line
 * (e.g. `launch("node", [...])` for `spawn as launch`, `run("...")` for
 * `exec: run`). Only matches stand-alone calls (not member calls like
 * `obj.launch(`) so an unrelated `.launch()` on another object is not flagged.
 * The alias name is already provenance-scoped to child_process by the caller.
 * Returns one entry per proven alias call occurrence, ordered by position, so
 * a line with several calls (e.g. `run("a"); run("b")`) reports each of them
 * instead of only the first (ClawSweeper P1: report every aliased execution
 * call on a line).
 */
function matchAliasedChildProcessCalls(
  line: string,
  methodAliases: Map<string, string>,
): Array<{ alias: string; index: number }> {
  const calls: Array<{ alias: string; index: number }> = [];
  for (const alias of methodAliases.keys()) {
    const pattern = new RegExp(`(?<![\\w.])${escapeRegExp(alias)}\\s*\\(`, "g");
    for (const callMatch of line.matchAll(pattern)) {
      calls.push({ alias, index: callMatch.index ?? -1 });
    }
  }
  return calls.toSorted((a, b) => a.index - b.index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The receiver names that, by long-standing convention, denote a direct
// child_process namespace. Namespace aliases collected at scan time extend
// this set so computed/exec calls through any proven binding are recognized.
const LITERAL_NAMESPACE_RECEIVERS = new Set(["cp", "childProcess", "child_process"]);

function isBenignMemberExecMatch(
  line: string,
  match: RegExpExecArray,
  namespaceAliases: Set<string>,
): boolean {
  // group 1 = direct call command, group 2 = computed-member command.
  const command = match[1] ?? match[2];
  if (!command) {
    return false;
  }

  const matchIndex = match.index ?? -1;
  if (matchIndex < 0) {
    return false;
  }

  const charAtMatch = line[matchIndex];
  // Computed-member call: `obj["spawn"](` / `obj["exec"](` — the match starts
  // at the opening quote, so `line.slice(0, matchIndex)` ends at the `[`.
  // Provenance is required for EVERY watched execution method, not only
  // `exec`: an unrelated `worker["spawn"]()` or `bus["execSync"]()` must stay
  // benign when the receiver is not a proven child_process namespace alias,
  // even if `child_process` appears elsewhere in the file. Only once the
  // receiver is a proven alias does the computed call get attributed to
  // child_process. (This also preserves the `RegExp.exec` exclusion: a regex's
  // `re["exec"](value)` receiver is not child_process-derived.)
  if (charAtMatch === '"' || charAtMatch === "'") {
    const receiverMatch = line.slice(0, matchIndex).match(/(\w+)\s*\[\s*$/);
    const receiver = receiverMatch?.[1];
    if (receiver && (namespaceAliases.has(receiver) || LITERAL_NAMESPACE_RECEIVERS.has(receiver))) {
      return false;
    }
    return true;
  }

  // Direct dot-member call: `obj.exec(` — the match starts at `exec`. This
  // branch only applies the long-standing `RegExp.exec` exclusion (a regex's
  // `.exec()` is not child_process-derived) and the provenance-aware receiver
  // check: a dot call through a collected namespace alias (e.g.
  // `proc.exec(` for `const proc = require("child_process")` or
  // `import * as proc from "node:child_process"`) is child_process-derived and
  // must be reported. Other dot-member execution calls fall through and are
  // reported as before.
  if (command === "exec" && matchIndex > 0 && line[matchIndex - 1] === ".") {
    const receiverMatch = line.slice(0, matchIndex - 1).match(/(\w+)\s*$/);
    const receiver = receiverMatch?.[1];
    if (receiver && (namespaceAliases.has(receiver) || LITERAL_NAMESPACE_RECEIVERS.has(receiver))) {
      return false;
    }
    return true;
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
  const sourceMatch = params.rule.pattern.exec(params.source);
  if (!sourceMatch) {
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

  // Multiline rules cannot match any one line. Preserve the actual match start
  // so stored findings point at the dangerous text instead of file metadata.
  let line = 1;
  for (let i = 0; i < sourceMatch.index; i++) {
    if (params.source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return { line, evidence: params.lines[line - 1] ?? truncateUtf16Safe(params.source, 120) };
}

export function scanSource(source: string, filePath: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  const lines = source.split("\n");
  const heuristicSource = stripCommentsForHeuristics(source);
  const heuristicLines = heuristicSource.split("\n");

  // Provenance-aware child_process bindings, collected once per source from
  // the comment-stripped text. Used to attribute aliased execution calls and
  // computed namespace calls back to their child_process origin. Cheap when
  // the source has no child_process reference at all (all regexes no-op).
  const { methodAliases, namespaceAliases } = collectChildProcessBindings(heuristicSource);

  // --- Line rules ---
  for (const rule of LINE_RULES) {
    // Skip rule entirely if context requirement not met
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

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
      const literalDangerousExecIndexes = new Set<number>();
      for (const match of matches) {
        if (
          rule.ruleId === "dangerous-exec" &&
          isBenignMemberExecMatch(line, match, namespaceAliases)
        ) {
          continue;
        }

        // Special handling for suspicious-network: check port
        if (rule.ruleId === "suspicious-network") {
          const port = Number.parseInt(expectDefined(match[1], "scanner regex capture 1"), 10);
          if (STANDARD_PORTS.has(port)) {
            continue;
          }
        }

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
        if (rule.ruleId === "dangerous-exec") {
          literalDangerousExecIndexes.add(match.index ?? -1);
        }
      }

      // Attribute aliased child_process calls (`launch(...)`, `run(...)`) that
      // the literal pattern cannot match. Only fires when the alias name was
      // bound from an actual child_process import/require (provenance-scoped),
      // so unrelated functions such as a locally-defined `launch()` do not.
      // Every proven alias call on the line is reported (per-occurrence
      // semantics), skipping any position the literal pattern already reported.
      if (rule.ruleId === "dangerous-exec" && methodAliases.size > 0) {
        for (const aliasMatch of matchAliasedChildProcessCalls(line, methodAliases)) {
          if (literalDangerousExecIndexes.has(aliasMatch.index)) {
            continue;
          }
          if (acceptedMatches >= MAX_LINE_RULE_FINDINGS_PER_RULE) {
            omittedMatches += 1;
            lastOmittedLine = i + 1;
            continue;
          }
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
