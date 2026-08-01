// Skill security scanner inspects skill files and manifests for unsafe patterns.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseFenceSpans } from "../../../packages/markdown-core/src/fences.js";
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

const DANGEROUS_CHILD_PROCESS_CALL_NAMES = [
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
] as const;
const DANGEROUS_CHILD_PROCESS_CALL_NAME_SET = new Set<string>(DANGEROUS_CHILD_PROCESS_CALL_NAMES);
const DANGEROUS_CHILD_PROCESS_CALL_PATTERN = new RegExp(
  `\\b(${DANGEROUS_CHILD_PROCESS_CALL_NAMES.join("|")})\\s*\\(`,
);

const LINE_RULES: LineRule[] = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    pattern: DANGEROUS_CHILD_PROCESS_CALL_PATTERN,
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

function isBenignMemberExecMatch(line: string, match: RegExpExecArray): boolean {
  const command = match[1];
  if (command !== "exec") {
    return false;
  }

  const matchIndex = match.index;
  if (matchIndex <= 0 || line[matchIndex - 1] !== ".") {
    return false;
  }

  return !/\b(?:cp|childProcess|child_process)\s*\.\s*exec\s*\(/.test(line);
}

const nodeRequire = createRequire(import.meta.url);
let typescriptRuntime: typeof import("typescript") | undefined;

function loadTypeScriptRuntime(): typeof import("typescript") {
  typescriptRuntime ??= nodeRequire("typescript") as typeof import("typescript");
  return typescriptRuntime;
}

function isChildProcessSpecifier(value: string): boolean {
  return value === "child_process" || value === "node:child_process";
}

function scriptKindForFile(
  ts: typeof import("typescript"),
  filePath: string,
): import("typescript").ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

const JAVASCRIPT_FENCE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["javascript", ".js"],
  ["js", ".js"],
  ["jsx", ".jsx"],
  ["typescript", ".ts"],
  ["ts", ".ts"],
  ["tsx", ".tsx"],
  ["mjs", ".mjs"],
  ["cjs", ".cjs"],
  ["mts", ".mts"],
  ["cts", ".cts"],
] as const);

type AliasScanSource = {
  source: string;
  file: string;
  lineOffset: number;
};

function collectLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1;) {
    starts.push(index + 1);
    index = source.indexOf("\n", index + 1);
  }
  return starts;
}

function lineOffsetAt(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(0, low - 1);
}

function collectAliasScanSources(source: string, filePath: string): AliasScanSource[] {
  if (path.extname(filePath).toLowerCase() !== ".md") {
    return [{ source, file: filePath, lineOffset: 0 }];
  }

  const scanSources: AliasScanSource[] = [];
  const lineStarts = collectLineStarts(source);
  const fenceSpans = parseFenceSpans(source);
  for (const [index, span] of fenceSpans.entries()) {
    const infoString = span.openLine.slice(span.indent.length + span.marker.length).trim();
    const language = infoString.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    // Fence labels are author-controlled metadata, not a security boundary. Parse
    // unknown and misleading labels as TypeScript so they cannot suppress scanning.
    const extension = JAVASCRIPT_FENCE_EXTENSIONS.get(language) ?? ".ts";

    const openingLineEnd = source.indexOf("\n", span.start);
    if (openingLineEnd === -1) {
      continue;
    }
    const contentStart = openingLineEnd + 1;
    const spanBody = source.slice(contentStart, span.end);
    const lastLineStart = spanBody.lastIndexOf("\n") + 1;
    const lastLine = spanBody.slice(lastLineStart).replace(/\r$/, "");
    const closingMarker = lastLine.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/)?.[2];
    const hasClosingFence =
      closingMarker !== undefined &&
      closingMarker[0] === span.marker[0] &&
      closingMarker.length >= span.marker.length;
    const content = hasClosingFence ? spanBody.slice(0, lastLineStart) : spanBody;
    scanSources.push({
      source: content,
      file: `${filePath}.${index}${extension}`,
      lineOffset: lineOffsetAt(lineStarts, contentStart),
    });
  }

  if (fenceSpans.length === 0) {
    return [{ source, file: `${filePath}.ts`, lineOffset: 0 }];
  }

  let previousEnd = 0;
  let outsideIndex = 0;
  for (const span of fenceSpans) {
    const segment = source.slice(previousEnd, span.start);
    if (segment.trim()) {
      scanSources.push({
        source: segment,
        file: `${filePath}.outside.${outsideIndex}.ts`,
        lineOffset: lineOffsetAt(lineStarts, previousEnd),
      });
      outsideIndex += 1;
    }
    previousEnd = span.end;
  }
  const trailingSegment = source.slice(previousEnd);
  if (trailingSegment.trim()) {
    scanSources.push({
      source: trailingSegment,
      file: `${filePath}.outside.${outsideIndex}.ts`,
      lineOffset: lineOffsetAt(lineStarts, previousEnd),
    });
  }
  return scanSources;
}

type ChildProcessBindingIdentifier = {
  binding: import("typescript").Identifier;
  requireIdentifier?: import("typescript").Identifier;
};

type ChildProcessBindingIdentifiers = {
  aliases: ChildProcessBindingIdentifier[];
  namespaces: ChildProcessBindingIdentifier[];
};

function unwrapAliasReferenceExpression(
  ts: typeof import("typescript"),
  expression: import("typescript").Expression,
): import("typescript").Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function getChildProcessRequireIdentifier(
  ts: typeof import("typescript"),
  expression: import("typescript").Expression,
): import("typescript").Identifier | undefined {
  const candidate = unwrapAliasReferenceExpression(ts, expression);
  if (!ts.isCallExpression(candidate)) {
    return undefined;
  }
  const requireExpression = unwrapAliasReferenceExpression(ts, candidate.expression);
  if (
    !ts.isIdentifier(requireExpression) ||
    requireExpression.text !== "require" ||
    candidate.arguments.length !== 1
  ) {
    return undefined;
  }
  const [specifier] = candidate.arguments;
  return specifier && ts.isStringLiteralLike(specifier) && isChildProcessSpecifier(specifier.text)
    ? requireExpression
    : undefined;
}

function getStaticMemberAccess(
  ts: typeof import("typescript"),
  expression: import("typescript").Expression,
): { expression: import("typescript").Expression; name: string } | undefined {
  const candidate = unwrapAliasReferenceExpression(ts, expression);
  if (ts.isPropertyAccessExpression(candidate)) {
    return { expression: candidate.expression, name: candidate.name.text };
  }
  if (
    ts.isElementAccessExpression(candidate) &&
    candidate.argumentExpression &&
    ts.isStringLiteralLike(candidate.argumentExpression)
  ) {
    return { expression: candidate.expression, name: candidate.argumentExpression.text };
  }
  return undefined;
}

function collectChildProcessBindingIdentifiers(
  ts: typeof import("typescript"),
  sourceFile: import("typescript").SourceFile,
): ChildProcessBindingIdentifiers {
  const aliases: ChildProcessBindingIdentifier[] = [];
  const namespaces: ChildProcessBindingIdentifier[] = [];
  const visit = (node: import("typescript").Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isChildProcessSpecifier(node.moduleSpecifier.text)
    ) {
      const importClause = node.importClause;
      const namedBindings = importClause?.namedBindings;
      if (importClause && !importClause.isTypeOnly && importClause.name) {
        namespaces.push({ binding: importClause.name });
      }
      if (
        importClause &&
        !importClause.isTypeOnly &&
        namedBindings &&
        ts.isNamedImports(namedBindings)
      ) {
        for (const element of namedBindings.elements) {
          if (!element.isTypeOnly && element.propertyName) {
            if (DANGEROUS_CHILD_PROCESS_CALL_NAME_SET.has(element.propertyName.text)) {
              aliases.push({ binding: element.name });
            } else if (element.propertyName.text === "default") {
              namespaces.push({ binding: element.name });
            }
          }
        }
      } else if (
        importClause &&
        !importClause.isTypeOnly &&
        namedBindings &&
        ts.isNamespaceImport(namedBindings)
      ) {
        namespaces.push({ binding: namedBindings.name });
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const requireIdentifier = getChildProcessRequireIdentifier(ts, node.initializer);
      if (requireIdentifier && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (
            element.propertyName &&
            (ts.isIdentifier(element.propertyName) ||
              ts.isStringLiteralLike(element.propertyName)) &&
            ts.isIdentifier(element.name) &&
            DANGEROUS_CHILD_PROCESS_CALL_NAME_SET.has(element.propertyName.text)
          ) {
            aliases.push({ binding: element.name, requireIdentifier });
          }
        }
      } else if (requireIdentifier && ts.isIdentifier(node.name)) {
        namespaces.push({ binding: node.name, requireIdentifier });
      } else if (ts.isIdentifier(node.name)) {
        const member = getStaticMemberAccess(ts, node.initializer);
        const memberRequireIdentifier = member
          ? getChildProcessRequireIdentifier(ts, member.expression)
          : undefined;
        if (
          member &&
          memberRequireIdentifier &&
          DANGEROUS_CHILD_PROCESS_CALL_NAME_SET.has(member.name)
        ) {
          aliases.push({ binding: node.name, requireIdentifier: memberRequireIdentifier });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { aliases, namespaces };
}

function createAliasTypeChecker(
  ts: typeof import("typescript"),
  sourceFile: import("typescript").SourceFile,
): import("typescript").TypeChecker {
  const options: import("typescript").CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
    types: [],
  };
  const host: import("typescript").CompilerHost = {
    fileExists: (fileName) => fileName === sourceFile.fileName,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getNewLine: () => "\n",
    getSourceFile: (fileName) => (fileName === sourceFile.fileName ? sourceFile : undefined),
    readFile: (fileName) => (fileName === sourceFile.fileName ? sourceFile.text : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  return ts.createProgram([sourceFile.fileName], options, host).getTypeChecker();
}

function returnsStaticRequireStub(
  ts: typeof import("typescript"),
  body: import("typescript").ConciseBody,
): boolean {
  const [onlyStatement] = ts.isBlock(body) ? body.statements : [];
  const returned = ts.isBlock(body)
    ? body.statements.length === 1 && onlyStatement && ts.isReturnStatement(onlyStatement)
      ? onlyStatement.expression
      : undefined
    : body;
  if (!returned) {
    return false;
  }
  const expression = unwrapAliasReferenceExpression(ts, returned);
  return ts.isObjectLiteralExpression(expression) || ts.isClassExpression(expression);
}

function isNodeRequireIdentifier(
  ts: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  identifier: import("typescript").Identifier,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) {
    return true;
  }
  const runtimeDeclarations = symbol.declarations?.filter((declaration) => {
    if (
      ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Ambient ||
      ts.isTypeOnlyImportDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration)
    ) {
      return false;
    }
    return !ts.isFunctionDeclaration(declaration) || Boolean(declaration.body);
  });
  if (!runtimeDeclarations?.length) {
    // Ambient/type-only declarations emit no binding, so Node still supplies
    // the runtime require. Treating them as shadows creates a scanner bypass.
    return true;
  }
  const isClearlyStaticStub = runtimeDeclarations.every((declaration) => {
    if (ts.isFunctionDeclaration(declaration) && declaration.body) {
      return returnsStaticRequireStub(ts, declaration.body);
    }
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return false;
    }
    const initializer = unwrapAliasReferenceExpression(ts, declaration.initializer);
    if (ts.isObjectLiteralExpression(initializer) || ts.isClassExpression(initializer)) {
      return true;
    }
    return (
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      returnsStaticRequireStub(ts, initializer.body)
    );
  });
  return !isClearlyStaticStub;
}

function collectDangerousChildProcessAliasCalls(
  source: string,
  filePath: string,
): Map<number, number> {
  const ts = loadTypeScriptRuntime();
  const parsedSources = collectAliasScanSources(source, filePath).map((candidate) => ({
    source: candidate.source,
    file: candidate.file,
    lineOffset: candidate.lineOffset,
    sourceFile: ts.createSourceFile(
      candidate.file,
      candidate.source,
      ts.ScriptTarget.Latest,
      false,
      scriptKindForFile(ts, candidate.file),
    ),
  }));

  const callCountsByLine = new Map<number, number>();
  for (const candidate of parsedSources) {
    // Markdown fragments are independent parse scopes. Keeping aliases local
    // prevents one example from tainting same-named calls in another fragment.
    const bindings = collectChildProcessBindingIdentifiers(ts, candidate.sourceFile);
    if (bindings.aliases.length === 0 && bindings.namespaces.length === 0) {
      continue;
    }
    const checker = createAliasTypeChecker(ts, candidate.sourceFile);
    const aliasSymbols = new Set<import("typescript").Symbol>();
    for (const candidateBinding of bindings.aliases) {
      if (
        candidateBinding.requireIdentifier &&
        !isNodeRequireIdentifier(ts, checker, candidateBinding.requireIdentifier)
      ) {
        continue;
      }
      const symbol = checker.getSymbolAtLocation(candidateBinding.binding);
      if (symbol) {
        aliasSymbols.add(symbol);
      }
    }
    const namespaceSymbols = new Set<import("typescript").Symbol>();
    for (const candidateBinding of bindings.namespaces) {
      if (
        candidateBinding.requireIdentifier &&
        !isNodeRequireIdentifier(ts, checker, candidateBinding.requireIdentifier)
      ) {
        continue;
      }
      const symbol = checker.getSymbolAtLocation(candidateBinding.binding);
      if (symbol) {
        namespaceSymbols.add(symbol);
      }
    }

    const collectNamespacePropertyAlias = (node: import("typescript").Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const namespaceExpression = unwrapAliasReferenceExpression(ts, node.initializer);
        if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(namespaceExpression)) {
          const namespaceSymbol = checker.getSymbolAtLocation(namespaceExpression);
          if (namespaceSymbol && namespaceSymbols.has(namespaceSymbol)) {
            for (const element of node.name.elements) {
              if (
                element.propertyName &&
                (ts.isIdentifier(element.propertyName) ||
                  ts.isStringLiteralLike(element.propertyName)) &&
                ts.isIdentifier(element.name) &&
                DANGEROUS_CHILD_PROCESS_CALL_NAME_SET.has(element.propertyName.text)
              ) {
                const aliasSymbol = checker.getSymbolAtLocation(element.name);
                if (aliasSymbol) {
                  aliasSymbols.add(aliasSymbol);
                }
              }
            }
          }
          ts.forEachChild(node, collectNamespacePropertyAlias);
          return;
        }
        if (!ts.isIdentifier(node.name)) {
          ts.forEachChild(node, collectNamespacePropertyAlias);
          return;
        }
        const member = getStaticMemberAccess(ts, node.initializer);
        if (member && DANGEROUS_CHILD_PROCESS_CALL_NAME_SET.has(member.name)) {
          const namespaceOwner = unwrapAliasReferenceExpression(ts, member.expression);
          if (ts.isIdentifier(namespaceOwner)) {
            const namespaceSymbol = checker.getSymbolAtLocation(namespaceOwner);
            if (namespaceSymbol && namespaceSymbols.has(namespaceSymbol)) {
              const aliasSymbol = checker.getSymbolAtLocation(node.name);
              if (aliasSymbol) {
                aliasSymbols.add(aliasSymbol);
              }
            }
          }
        }
      }
      ts.forEachChild(node, collectNamespacePropertyAlias);
    };
    collectNamespacePropertyAlias(candidate.sourceFile);

    const visit = (node: import("typescript").Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = unwrapAliasReferenceExpression(ts, node.expression);
        if (!ts.isIdentifier(expression)) {
          ts.forEachChild(node, visit);
          return;
        }
        const symbol = checker.getSymbolAtLocation(expression);
        if (
          symbol &&
          aliasSymbols.has(symbol) &&
          !DANGEROUS_CHILD_PROCESS_CALL_NAME_SET.has(expression.text)
        ) {
          const candidateLine =
            candidate.sourceFile.getLineAndCharacterOfPosition(
              expression.getStart(candidate.sourceFile),
            ).line + 1;
          const sourceLine = candidate.lineOffset + candidateLine;
          callCountsByLine.set(sourceLine, (callCountsByLine.get(sourceLine) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(candidate.sourceFile);
  }
  return callCountsByLine;
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

  // --- Line rules ---
  for (const rule of LINE_RULES) {
    // Skip rule entirely if context requirement not met
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    let acceptedMatches = 0;
    let omittedMatches = 0;
    let lastOmittedLine: number | undefined;
    const aliasCallCounts =
      rule.ruleId === "dangerous-exec"
        ? collectDangerousChildProcessAliasCalls(source, filePath)
        : undefined;
    const recordFinding = (lineIndex: number, evidence: string): void => {
      if (acceptedMatches >= MAX_LINE_RULE_FINDINGS_PER_RULE) {
        omittedMatches += 1;
        lastOmittedLine = lineIndex + 1;
        return;
      }

      // Retain distinct calls up to the cap, then aggregate every remaining match.
      // This keeps hostile output bounded without hiding that later sites exist.
      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        file: filePath,
        line: lineIndex + 1,
        message: rule.message,
        evidence: formatScanEvidence(evidence),
      });
      acceptedMatches += 1;
    };
    for (const [i, line] of lines.entries()) {
      // Match execution calls without comments, but retain the raw line as finding evidence.
      const scanLine = rule.ruleId === "dangerous-exec" ? (heuristicLines[i] ?? "") : line;
      const matches = scanLine.matchAll(
        new RegExp(
          rule.pattern.source,
          rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`,
        ),
      );
      for (const match of matches) {
        if (rule.ruleId === "dangerous-exec" && isBenignMemberExecMatch(scanLine, match)) {
          continue;
        }

        // Special handling for suspicious-network: check port
        if (rule.ruleId === "suspicious-network") {
          const port = Number.parseInt(expectDefined(match[1], "scanner regex capture 1"), 10);
          if (STANDARD_PORTS.has(port)) {
            continue;
          }
        }

        recordFinding(i, line);
      }

      for (let occurrence = 0; occurrence < (aliasCallCounts?.get(i + 1) ?? 0); occurrence += 1) {
        recordFinding(i, line);
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
