import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { clampNumber } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { toCodeModeJsonSafe } from "./code-mode-json.js";
import { createCodeModeApiVirtualFiles } from "./code-mode-namespaces.js";
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
  enabled: boolean;
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

type CodeModeBridgeMethod =
  | "search"
  | "describe"
  | "call"
  | "callValue"
  | "yield"
  | "namespace"
  | "agentSpawn"
  | "agentWait"
  | "swarmNote";

export type PendingBridgeRequest = {
  id: string;
  method: CodeModeBridgeMethod;
  args: unknown[];
};

export type SettledBridgeRequest = { id: string } & Result<unknown, string>;

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
  | {
      status: "completed";
      value: unknown;
      output: unknown[];
    }
  | {
      status: "waiting";
      snapshotBytes: Uint8Array;
      pendingRequests: PendingBridgeRequest[];
      output: unknown[];
    }
  | {
      status: "failed";
      error: string;
      code: CodeModeFailureCode;
      output: unknown[];
    };

const typescriptRuntimeLoader = createLazyPromiseLoader(() => import("typescript"), {
  cacheRejections: true,
});
let typescriptRuntimeForTest: typeof import("typescript") | null = null;

function normalizeCodeModeRawConfig(value: unknown): Record<string, unknown> | undefined {
  const codeMode = value;
  if (codeMode === true) {
    return { enabled: true };
  }
  if (codeMode === false) {
    return { enabled: false };
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

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
    enabled: readBoolean(raw.enabled, false),
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
  return {
    ...base,
    timeoutMs: clampNumber(readPositiveInteger(overrides?.timeoutMs, base.timeoutMs), 100, 60_000),
    memoryLimitBytes: clampNumber(
      readPositiveInteger(overrides?.memoryLimitBytes, base.memoryLimitBytes),
      1024 * 1024,
      1024 * 1024 * 1024,
    ),
    maxOutputBytes: clampNumber(
      readPositiveInteger(overrides?.maxOutputBytes, base.maxOutputBytes),
      1024,
      10 * 1024 * 1024,
    ),
    maxSnapshotBytes: clampNumber(
      readPositiveInteger(overrides?.maxSnapshotBytes, base.maxSnapshotBytes),
      1024,
      256 * 1024 * 1024,
    ),
    maxPendingToolCalls: clampNumber(
      readPositiveInteger(overrides?.maxPendingToolCalls, base.maxPendingToolCalls),
      1,
      128,
    ),
  };
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(toCodeModeJsonSafe(value)) ?? "null", "utf8");
}

class CodeModeLimitError extends ToolInputError {
  readonly code: Extract<CodeModeFailureCode, "output_limit_exceeded" | "snapshot_limit_exceeded">;

  constructor(
    code: Extract<CodeModeFailureCode, "output_limit_exceeded" | "snapshot_limit_exceeded">,
    message: string,
  ) {
    super(message);
    this.name = "CodeModeLimitError";
    this.code = code;
  }
}

function isRuntimeInterruptedError(error: unknown): boolean {
  return errorMessage(error) === "interrupted";
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
  return isRuntimeInterruptedError(error) ? "code mode timeout exceeded" : errorMessage(error);
}

export function enforceOutputLimit(output: unknown[], config: CodeModeConfig): void {
  if (jsonByteLength(output) > config.maxOutputBytes) {
    throw new CodeModeLimitError("output_limit_exceeded", "code mode output limit exceeded");
  }
}

export function enforceResultLimit(params: {
  output: unknown[];
  value?: unknown;
  config: CodeModeConfig;
}): void {
  enforceOutputLimit(params.output, params.config);
  if (params.value !== undefined && jsonByteLength(params.value) > params.config.maxOutputBytes) {
    throw new CodeModeLimitError("output_limit_exceeded", "code mode output limit exceeded");
  }
}

export function readCode(args: unknown): {
  code: string;
  language?: CodeModeLanguage;
  restartSafe: boolean;
} {
  const params = asToolParamsRecord(args);
  const codeParam = params.code;
  const commandParam = params.command;
  if (
    typeof codeParam === "string" &&
    typeof commandParam === "string" &&
    codeParam !== commandParam
  ) {
    throw new ToolInputError("code and command must match when both are provided.");
  }
  const code = typeof commandParam === "string" ? commandParam : codeParam;
  if (typeof code !== "string" || !code.trim()) {
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

function maskCodeLiteralsAndComments(code: string): string {
  // Module access detection should ignore strings and comments so examples or
  // prose containing `import`/`require` do not reject otherwise valid code.
  let masked = "";
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (char === "/" && next === "/") {
      masked += "  ";
      index += 2;
      while (index < code.length && code[index] !== "\n") {
        masked += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      masked += "  ";
      index += 2;
      while (index < code.length) {
        if (code[index] === "*" && code[index + 1] === "/") {
          masked += "  ";
          index += 2;
          break;
        }
        masked += code[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      masked += " ";
      index += 1;
      while (index < code.length) {
        const current = code[index];
        masked += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === "\\") {
          if (index < code.length) {
            masked += code[index] === "\n" ? "\n" : " ";
            index += 1;
          }
          continue;
        }
        if (current === quote) {
          break;
        }
      }
      continue;
    }
    masked += char;
    index += 1;
  }
  return masked;
}

function rejectsModuleAccess(code: string): boolean {
  const source = maskCodeLiteralsAndComments(code);
  return /\bimport\b\s*(?:\.|\(|["'`{*]|\w)|\brequire\b\s*\(/u.test(source);
}

async function loadTypeScriptRuntime(): Promise<typeof import("typescript")> {
  if (typescriptRuntimeForTest) {
    return typescriptRuntimeForTest;
  }
  return await typescriptRuntimeLoader.load();
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
  if (rejectsModuleAccess(input.code)) {
    throw new ToolInputError("code mode module access is disabled.");
  }
  if (language === "javascript") {
    return input.code;
  }
  const ts = await loadTypeScriptRuntime();
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
  if (rejectsModuleAccess(transformed.outputText)) {
    throw new ToolInputError("code mode module access is disabled.");
  }
  return transformed.outputText;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

export function createCodeModeApiFilesForRun(
  catalog: Parameters<typeof createCodeModeApiVirtualFiles>[0],
  swarmEnabled: boolean,
) {
  const files = createCodeModeApiVirtualFiles(catalog);
  return swarmEnabled ? files : files.filter((file) => file.path !== "agents.d.ts");
}

export function enforceSnapshotPayloadLimits(params: {
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
  output: unknown[];
}) {
  if (params.snapshotBytes.byteLength > params.config.maxSnapshotBytes) {
    throw new CodeModeLimitError("snapshot_limit_exceeded", "code mode snapshot limit exceeded");
  }
  enforceOutputLimit(params.output, params.config);
}

export const codeModeRuntimeTesting = {
  getTypescriptRuntimePromise: (): Promise<typeof import("typescript")> | null =>
    typescriptRuntimeLoader.peek() ?? null,
  setTypescriptRuntimeForTest: (runtime: typeof import("typescript") | null) => {
    typescriptRuntimeForTest = runtime;
  },
};
