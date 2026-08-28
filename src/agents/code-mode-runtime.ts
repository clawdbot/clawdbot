import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { parse, tokenizer } from "acorn";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { clampNumber } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { boundCodeModeResult } from "./code-mode-json.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import {
  buildCodeModeScriptParseSource,
  parseCodeModeScriptSyntax,
} from "./code-mode-script-syntax.js";
import {
  CODE_MODE_SHELL_SOURCE_ERROR,
  isShellLikeCodeModeSource,
} from "./code-mode-shell-source.js";
import { loadCodeModeTypeScriptRuntime } from "./code-mode-typescript-runtime.js";
import type { CodeModeFailurePhase, CodeModeWorkerThreadResult } from "./code-mode-worker-types.js";
import type { ToolSearchConfig, ToolSearchToolContext } from "./tool-search.js";
import { asToolParamsRecord, ToolInputError } from "./tools/common.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PENDING_TOOL_CALLS = 16;
const DEFAULT_SNAPSHOT_TTL_SECONDS = 900;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 50;
export const CODE_MODE_WORKER_WATCHDOG_GRACE_MS = 2_000;
export const DEFAULT_HEADLESS_WALL_CLOCK_MS = 30_000;
// Cron script payloads persist caps of 900 seconds and 200 tool calls.
// The shared executor must not silently lower those accepted job limits.
export const MAX_HEADLESS_WALL_CLOCK_MS = 900_000;
export const DEFAULT_HEADLESS_TOOL_CALLS = 5;
export const MAX_HEADLESS_TOOL_CALLS = 200;

export type CodeModeLanguage = "javascript" | "typescript";

/** Resolved Code Mode runtime limits and visible language options. */
export type CodeModeConfig = {
  /** Master switch tier: true/false, or "auto" (engage per model catalog flag). */
  enabled: boolean | "auto";
  runtime: "quickjs-wasi";
  mode: "only";
  languages: CodeModeLanguage[];
  timeoutMs: number;
  memoryLimitBytes: number;
  maxOutputBytes: number;
  maxSnapshotBytes: number;
  maxPendingToolCalls: number;
  snapshotTtlSeconds: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
};

export type {
  CodeModeSettlementMode,
  PendingBridgeRequest,
  SettledBridgeRequest,
} from "./code-mode-worker-types.js";

export type CodeModeFailureCode =
  | "aborted"
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";

export type CodeModeHeadlessResult =
  | {
      status: "completed";
      value: unknown;
      output: unknown[];
      toolCallCount: number;
    }
  | {
      status: "failed";
      code: CodeModeFailureCode | "tool_budget_exceeded";
      error: string;
      output: unknown[];
      toolCallCount: number;
    };

export type CodeModeWorkerResult =
  | Extract<CodeModeWorkerThreadResult, { status: "completed" | "waiting" }>
  | {
      status: "failed";
      error: string;
      code: CodeModeFailureCode;
      failurePhase: CodeModeFailurePhase;
      bridgeDispatchStarted: boolean;
      output: unknown[];
    };

function normalizeCodeModeRawConfig(value: unknown): Record<string, unknown> | undefined {
  const codeMode = value;
  if (codeMode === true) {
    return { enabled: true };
  }
  if (codeMode === false) {
    return { enabled: false };
  }
  if (codeMode === "auto") {
    return { enabled: "auto" };
  }
  return isRecord(codeMode) ? codeMode : undefined;
}

function readCodeModeRawConfig(config?: OpenClawConfig, agentId?: string): Record<string, unknown> {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  const globalRaw = normalizeCodeModeRawConfig(tools?.codeMode) ?? {};
  const agentRaw =
    config && agentId
      ? normalizeCodeModeRawConfig(resolveAgentConfig(config, agentId)?.tools?.codeMode)
      : undefined;
  return agentRaw ? { ...globalRaw, ...agentRaw } : globalRaw;
}

function readEnabled(raw: Record<string, unknown>): boolean | "auto" {
  const value = raw.enabled;
  if (typeof value === "boolean" || value === "auto") {
    return value;
  }
  return Object.keys(raw).some((key) => key !== "enabled") ? "auto" : false;
}

export function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readLanguages(value: unknown): CodeModeLanguage[] {
  if (!Array.isArray(value)) {
    return ["javascript", "typescript"];
  }
  const languages = value.filter(
    (entry): entry is CodeModeLanguage => entry === "javascript" || entry === "typescript",
  );
  return languages.length > 0 ? uniqueValues(languages) : ["javascript", "typescript"];
}

/** Resolves Code Mode runtime limits and language support from config. */
export function resolveCodeModeConfig(config?: OpenClawConfig, agentId?: string): CodeModeConfig {
  const raw = readCodeModeRawConfig(config, agentId);
  const maxSearchLimit = clampNumber(
    readPositiveInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT),
    1,
    DEFAULT_MAX_SEARCH_LIMIT,
  );
  return {
    enabled: readEnabled(raw),
    runtime: "quickjs-wasi",
    mode: "only",
    languages: readLanguages(raw.languages),
    timeoutMs: clampNumber(readPositiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS), 100, 60_000),
    memoryLimitBytes: clampNumber(
      readPositiveInteger(raw.memoryLimitBytes, DEFAULT_MEMORY_LIMIT_BYTES),
      1024 * 1024,
      1024 * 1024 * 1024,
    ),
    maxOutputBytes: clampNumber(
      readPositiveInteger(raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      1024,
      10 * 1024 * 1024,
    ),
    maxSnapshotBytes: clampNumber(
      readPositiveInteger(raw.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES),
      1024,
      256 * 1024 * 1024,
    ),
    maxPendingToolCalls: clampNumber(
      readPositiveInteger(raw.maxPendingToolCalls, DEFAULT_MAX_PENDING_TOOL_CALLS),
      1,
      128,
    ),
    snapshotTtlSeconds: clampNumber(
      readPositiveInteger(raw.snapshotTtlSeconds, DEFAULT_SNAPSHOT_TTL_SECONDS),
      1,
      24 * 60 * 60,
    ),
    searchDefaultLimit: clampNumber(
      readPositiveInteger(raw.searchDefaultLimit, DEFAULT_SEARCH_LIMIT),
      1,
      maxSearchLimit,
    ),
    maxSearchLimit,
  };
}

/**
 * Resolves the master switch against one model's catalog capability flag.
 * `true`/`false` are absolute; `"auto"` engages only for models whose catalog
 * compat declares `codeMode: "preferred"`. This gates the model-facing tool
 * surface only; runs that route to a provider-native harness (for example the
 * default OpenAI Codex surface) never reach this embedded-runtime gate.
 */
export function isCodeModeEngagedForModel(
  config: Pick<CodeModeConfig, "enabled">,
  model: { compat?: unknown } | undefined,
): boolean {
  if (config.enabled !== "auto") {
    return config.enabled;
  }
  const compat =
    model?.compat && typeof model.compat === "object"
      ? (model.compat as { codeMode?: unknown })
      : undefined;
  return compat?.codeMode === "preferred";
}

export function toToolSearchConfig(config: CodeModeConfig): ToolSearchConfig {
  return {
    enabled: true,
    mode: "tools",
    codeTimeoutMs: config.timeoutMs,
    searchDefaultLimit: config.searchDefaultLimit,
    maxSearchLimit: config.maxSearchLimit,
  };
}

export function resolveCodeModeHeadlessConfig(
  ctx: ToolSearchToolContext,
  overrides?: Partial<
    Pick<
      CodeModeConfig,
      | "timeoutMs"
      | "memoryLimitBytes"
      | "maxOutputBytes"
      | "maxSnapshotBytes"
      | "maxPendingToolCalls"
    >
  >,
): CodeModeConfig {
  const base = resolveCodeModeConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId);
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined),
  );
  return resolveCodeModeConfig({
    tools: { codeMode: { ...base, ...definedOverrides } },
  } as OpenClawConfig);
}

class CodeModeLimitError extends ToolInputError {
  readonly code = "snapshot_limit_exceeded" as const;

  constructor(message: string) {
    super(message);
    this.name = "CodeModeLimitError";
  }
}

function isRuntimeInterruptedError(error: unknown): boolean {
  return (error instanceof Error ? error.message : error) === "interrupted";
}

export function codeModeFailureCode(error: unknown): CodeModeFailureCode {
  if (error instanceof CodeModeLimitError) {
    return error.code;
  }
  if (isRuntimeInterruptedError(error)) {
    return "timeout";
  }
  return error instanceof ToolInputError ? "invalid_input" : "internal_error";
}

export function codeModeFailureMessage(error: unknown): string {
  return isRuntimeInterruptedError(error)
    ? "code mode timeout exceeded"
    : formatErrorMessage(error);
}

export function boundOutputToLimit(output: unknown[], config: CodeModeConfig): boolean {
  const bounded = boundCodeModeResult({ output, maxOutputBytes: config.maxOutputBytes });
  output.splice(0, output.length, ...bounded.output);
  return bounded.truncated;
}

export function readCode(args: unknown): {
  code: string;
  language?: CodeModeLanguage;
  restartSafe: boolean;
} {
  const params = asToolParamsRecord(args);
  // Full-schema tool calls can materialize an unused alias as blank.
  // Only nonblank aliases participate in divergence checks.
  const codeAlias = readNonBlankString(params.code);
  const commandAlias = readNonBlankString(params.command);
  if (codeAlias !== undefined && commandAlias !== undefined && codeAlias !== commandAlias) {
    throw new ToolInputError("code and command must match when both are provided.");
  }
  const code = commandAlias ?? codeAlias;
  if (code === undefined) {
    throw new ToolInputError("code or command must be a non-empty string.");
  }
  const language = params.language;
  if (language !== undefined && language !== "javascript" && language !== "typescript") {
    throw new ToolInputError("language must be javascript or typescript.");
  }
  const restartSafe = params.restartSafe;
  if (restartSafe !== undefined && typeof restartSafe !== "boolean") {
    throw new ToolInputError("restartSafe must be a boolean.");
  }
  return { code, language, restartSafe: restartSafe === true };
}

export function readRunId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const runId = params.runId ?? params.run_id;
  if (typeof runId !== "string" || !runId.trim()) {
    throw new ToolInputError("runId must be a non-empty string.");
  }
  return runId.trim();
}

function maskCodeLiteralsAndComments(
  code: string,
  typescriptRuntime?: typeof import("typescript"),
): string {
  let masked = code.split("");
  const maskRange = (start: number, end: number, offset = 0) => {
    for (
      let index = Math.max(start - offset, 0);
      index < Math.min(end - offset, masked.length);
      index += 1
    ) {
      if (masked[index] !== "\n" && masked[index] !== "\r") {
        masked[index] = " ";
      }
    }
  };

  try {
    const wrapped = buildCodeModeScriptParseSource(code);
    parse(wrapped.source, {
      ecmaVersion: "latest",
      onComment: (_isBlock, _text, start, end) => maskRange(start, end, wrapped.codeOffset),
      onToken: (token) => {
        // Parse in the real async guest context: standalone tokenization can
        // mistake executable division for a regex after contextual keywords.
        if (
          token.type.label === "string" ||
          token.type.label === "regexp" ||
          token.type.label === "template"
        ) {
          maskRange(token.start, token.end, wrapped.codeOffset);
        }
      },
    });
    return masked.join("");
  } catch {
    // Parser and tokenizer offsets are UTF-16 code units, not Unicode points.
    masked = code.split("");
    if (typescriptRuntime) {
      try {
        const sourceFile = typescriptRuntime.createSourceFile(
          "code-mode.ts",
          code,
          typescriptRuntime.ScriptTarget.ES2022,
          true,
          typescriptRuntime.ScriptKind.TS,
        );
        const visit = (node: import("typescript").Node) => {
          typescriptRuntime.forEachLeadingCommentRange(code, node.getFullStart(), (start, end) =>
            maskRange(start, end),
          );
          typescriptRuntime.forEachTrailingCommentRange(code, node.getEnd(), (start, end) =>
            maskRange(start, end),
          );
          if (
            typescriptRuntime.isStringLiteralLike(node) ||
            typescriptRuntime.isRegularExpressionLiteral(node) ||
            typescriptRuntime.isTemplateHead(node) ||
            typescriptRuntime.isTemplateMiddle(node) ||
            typescriptRuntime.isTemplateTail(node)
          ) {
            maskRange(node.getStart(sourceFile), node.getEnd());
          }
          typescriptRuntime.forEachChild(node, visit);
        };
        visit(sourceFile);
        return masked.join("");
      } catch {
        // A failed TypeScript parse must never expose a partially masked scan.
        return code;
      }
    }

    // Malformed JavaScript needs a conservative lexical pass: never trust a
    // context-free regexp token to hide executable module access.
    try {
      for (const token of tokenizer(code, {
        ecmaVersion: "latest",
        onComment: (_isBlock, _text, start, end) => maskRange(start, end),
      })) {
        if (token.type.label === "string" || token.type.label === "template") {
          maskRange(token.start, token.end);
        }
      }
      return masked.join("");
    } catch {
      // Never inspect partially masked input after a tokenizer failure.
      return code;
    }
  }
}

function isModuleLoaderCallee(callee: import("acorn").Expression | import("acorn").Super): boolean {
  if (callee.type === "ParenthesizedExpression") {
    return isModuleLoaderCallee(callee.expression);
  }
  if (callee.type === "ChainExpression") {
    return isModuleLoaderCallee(callee.expression);
  }
  if (callee.type === "SequenceExpression") {
    const expression = callee.expressions[callee.expressions.length - 1];
    return expression !== undefined && isModuleLoaderCallee(expression);
  }
  return callee.type === "Identifier" && callee.name === "require";
}

function containsModuleAccess(node: import("acorn").AnyNode): boolean {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ImportExpression" ||
    (node.type === "MetaProperty" && node.meta.name === "import") ||
    (node.type === "CallExpression" && isModuleLoaderCallee(node.callee))
  ) {
    return true;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (
          child !== null &&
          typeof child === "object" &&
          "type" in child &&
          typeof child.type === "string" &&
          containsModuleAccess(child as import("acorn").AnyNode)
        ) {
          return true;
        }
      }
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      "type" in value &&
      typeof value.type === "string" &&
      containsModuleAccess(value as import("acorn").AnyNode)
    ) {
      return true;
    }
  }
  return false;
}

function typeScriptContainsModuleAccess(code: string, ts: typeof import("typescript")): boolean {
  const source = ts.createSourceFile(
    "code-mode.ts",
    code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const isLoaderCallee = (expression: import("typescript").Expression): boolean => {
    if (ts.isParenthesizedExpression(expression)) {
      return isLoaderCallee(expression.expression);
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      return isLoaderCallee(expression.right);
    }
    return ts.isIdentifier(expression) && expression.text === "require";
  };

  const visit = (node: import("typescript").Node): boolean => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || isLoaderCallee(node.expression)))
    ) {
      return true;
    }
    return ts.forEachChild(node, (child) => (visit(child) ? true : undefined)) === true;
  };

  return visit(source);
}

function rejectsModuleAccess(
  code: string,
  typescriptRuntime?: typeof import("typescript"),
): boolean {
  const parsed = parseCodeModeScriptSyntax(code);
  if (parsed.ok) {
    // The WASI guest has no host module loader. Only executable module syntax
    // belongs in this early check; ordinary guest methods are not capabilities.
    return containsModuleAccess(parsed.program);
  }
  if (typescriptRuntime) {
    try {
      return typeScriptContainsModuleAccess(code, typescriptRuntime);
    } catch {
      // Keep malformed input on the conservative lexical fallback.
    }
  }
  const source = maskCodeLiteralsAndComments(code, typescriptRuntime);
  return /\bimport\b\s*(?:\.|\(|["'`{*]|\w)|\brequire\b\s*\(/u.test(source);
}

export async function prepareSource(input: {
  code: string;
  language?: CodeModeLanguage;
  config: CodeModeConfig;
}): Promise<string> {
  const language = input.language ?? "javascript";
  if (!input.config.languages.includes(language)) {
    throw new ToolInputError(`code mode ${language} input is disabled.`);
  }
  if (language === "javascript") {
    if (rejectsModuleAccess(input.code)) {
      throw new ToolInputError("code mode module access is disabled.");
    }
    if (isShellLikeCodeModeSource(input.code)) {
      throw new ToolInputError(CODE_MODE_SHELL_SOURCE_ERROR);
    }
    return input.code;
  }
  const ts = await loadCodeModeTypeScriptRuntime();
  if (rejectsModuleAccess(input.code, ts)) {
    throw new ToolInputError("code mode module access is disabled.");
  }
  const transformed = ts.transpileModule(input.code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      sourceMap: false,
    },
    reportDiagnostics: true,
  });
  const diagnostics = transformed.diagnostics ?? [];
  if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    const message = diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
      .join("\n");
    throw new ToolInputError(`typescript transform failed: ${message}`);
  }
  if (rejectsModuleAccess(transformed.outputText, ts)) {
    throw new ToolInputError("code mode module access is disabled.");
  }
  if (
    isShellLikeCodeModeSource(input.code, transformed.outputText) ||
    isShellLikeCodeModeSource(transformed.outputText)
  ) {
    throw new ToolInputError(CODE_MODE_SHELL_SOURCE_ERROR);
  }
  return transformed.outputText;
}

export function createCodeModeApiFilesForRun(
  namespaceRuntime: CodeModeNamespaceRuntime,
  swarmEnabled: boolean,
) {
  const { apiFiles: files } = namespaceRuntime;
  return swarmEnabled ? files : files.filter((file) => file.path !== "agents.d.ts");
}

export function enforceSnapshotPayloadLimits(params: {
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
}) {
  if (params.snapshotBytes.byteLength > params.config.maxSnapshotBytes) {
    throw new CodeModeLimitError("code mode snapshot limit exceeded");
  }
}
