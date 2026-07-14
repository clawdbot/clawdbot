/**
 * Host-side Code Mode controller for isolated QuickJS execution with bridged
 * tool search/call/yield support.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import { clampNumber } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeControlTool,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import { toCodeModeJsonSafe } from "./code-mode-json.js";
import {
  createCodeModeApiVirtualFiles,
  createCodeModeNamespaceRuntime,
  describeCodeModeNamespacesForPrompt,
  type CodeModeNamespaceDescriptor,
  type CodeModeNamespaceRuntime,
  type SerializedCodeModeNamespaceValue,
} from "./code-mode-namespaces.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { optionalStringEnum } from "./schema/typebox.js";
import type { ToolDefinition } from "./sessions/index.js";
import {
  addClientToolsToToolCatalog,
  applyToolCatalogCompaction,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  ToolSearchRuntime,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchConfig,
  type ToolSearchToolContext,
} from "./tool-search.js";
import {
  asToolParamsRecord,
  jsonResult,
  ToolInputError,
  type AnyAgentTool,
} from "./tools/common.js";
export {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeControlTool,
} from "./code-mode-control-tools.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PENDING_TOOL_CALLS = 16;
const DEFAULT_SNAPSHOT_TTL_SECONDS = 900;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 50;
const MAX_ACTIVE_CODE_MODE_RUNS = 64;

type CodeModeLanguage = "javascript" | "typescript";

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

type CodeModeBridgeMethod = "search" | "describe" | "call" | "yield" | "namespace";

type PendingBridgeRequest = {
  id: string;
  method: CodeModeBridgeMethod;
  args: unknown[];
};

type SettledBridgeRequest = { id: string } & Result<unknown, string>;

type PendingBridgeState = PendingBridgeRequest & {
  promise: Promise<SettledBridgeRequest>;
  settled?: SettledBridgeRequest;
};

type CodeModeRunState = {
  runId: string;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  snapshotBytes: Uint8Array;
  pending: PendingBridgeState[];
  // True only when every future bridge call is enforced read-only before execution.
  replaySafe: boolean;
  output: unknown[];
  createdAt: number;
  expiresAt: number;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
};

type CodeModeToolContext = ToolSearchToolContext;

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

type CodeModeWorkerResult =
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

const activeRuns = new Map<string, CodeModeRunState>();
const resumingRunIds = new Set<string>();
let activeRunReservations = 0;
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

function readPositiveInteger(value: unknown, fallback: number): number {
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

function toToolSearchConfig(config: CodeModeConfig): ToolSearchConfig {
  return {
    enabled: true,
    mode: "tools",
    codeTimeoutMs: config.timeoutMs,
    searchDefaultLimit: config.searchDefaultLimit,
    maxSearchLimit: config.maxSearchLimit,
  };
}

function resolveCodeModeHeadlessConfig(
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

function removeExpiredRuns(now = Date.now()): void {
  for (const [runId, state] of activeRuns) {
    if (!isFutureDateTimestampMs(state.expiresAt, { nowMs: now })) {
      activeRuns.delete(runId);
      resumingRunIds.delete(runId);
    }
  }
}

function resolveCodeModeSnapshotExpiresAt(now: number, ttlSeconds: number): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(ttlSeconds, { nowMs: now });
}

function enforceActiveRunLimit(): void {
  removeExpiredRuns();
  if (activeRuns.size + activeRunReservations >= MAX_ACTIVE_CODE_MODE_RUNS) {
    throw new ToolInputError("too many suspended code mode runs.");
  }
}

function reserveActiveRunSlot(): () => void {
  enforceActiveRunLimit();
  activeRunReservations += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeRunReservations = Math.max(0, activeRunReservations - 1);
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

function codeModeFailureCode(error: unknown): CodeModeFailureCode {
  if (error instanceof CodeModeLimitError) {
    return error.code;
  }
  if (isRuntimeInterruptedError(error)) {
    return "timeout";
  }
  return error instanceof ToolInputError ? "invalid_input" : "internal_error";
}

function codeModeFailureMessage(error: unknown): string {
  return isRuntimeInterruptedError(error) ? "code mode timeout exceeded" : errorMessage(error);
}

function enforceOutputLimit(output: unknown[], config: CodeModeConfig): void {
  if (jsonByteLength(output) > config.maxOutputBytes) {
    throw new CodeModeLimitError("output_limit_exceeded", "code mode output limit exceeded");
  }
}

function enforceResultLimit(params: {
  output: unknown[];
  value?: unknown;
  config: CodeModeConfig;
}): void {
  enforceOutputLimit(params.output, params.config);
  if (params.value !== undefined && jsonByteLength(params.value) > params.config.maxOutputBytes) {
    throw new CodeModeLimitError("output_limit_exceeded", "code mode output limit exceeded");
  }
}

function readCode(args: unknown): {
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

function readRunId(args: unknown): string {
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

async function prepareSource(input: {
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}

async function runBridgeRequest(params: {
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  parentToolCallId: string;
  request: PendingBridgeRequest;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<SettledBridgeRequest> {
  try {
    const values = Array.isArray(params.request.args) ? params.request.args : [];
    let value: unknown;
    switch (params.request.method) {
      case "search": {
        const query = values[0];
        if (typeof query !== "string") {
          throw new ToolInputError("search query must be a string.");
        }
        const options = isRecord(values[1]) ? values[1] : undefined;
        value = await params.runtime.search(query, {
          limit: typeof options?.limit === "number" ? options.limit : undefined,
          includeMcp: false,
        });
        break;
      }
      case "describe": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("describe id must be a string.");
        }
        value = await params.runtime.describe(id, {
          includeMcp: false,
          recoverySurface: "tools",
        });
        break;
      }
      case "call": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("call id must be a string.");
        }
        const described = await params.runtime.describe(id, {
          includeMcp: false,
          recoverySurface: "tools",
        });
        value = await params.runtime.callExactId(described.id, values[1] ?? {}, {
          parentToolCallId: params.parentToolCallId,
          signal: params.signal,
          onUpdate: params.onUpdate,
        });
        break;
      }
      case "yield": {
        value = { status: "yielded", reason: values[0] ?? null };
        break;
      }
      case "namespace": {
        const namespaceId = values[0];
        const pathLocal = values[1];
        const callArgs = values[2];
        if (typeof namespaceId !== "string") {
          throw new ToolInputError("namespace id must be a string.");
        }
        if (!Array.isArray(pathLocal) || !pathLocal.every((entry) => typeof entry === "string")) {
          throw new ToolInputError("namespace path must be an array of strings.");
        }
        value = await params.namespaceRuntime.invoke(
          namespaceId,
          pathLocal,
          Array.isArray(callArgs) ? callArgs : [],
          async (request) => {
            const entry = request.catalogId
              ? params.runtime
                  .namespaceEntries()
                  .find((candidate) => candidate.id === request.catalogId)
              : params.runtime
                  .namespaceEntries()
                  .find(
                    (candidate) =>
                      candidate.name === request.toolName &&
                      candidate.sourceName === request.pluginId,
                  );
            if (!entry) {
              throw new ToolInputError(
                `namespace tool is not visible in the run catalog: ${request.toolName}`,
              );
            }
            const called = await params.runtime.callExactId(entry.id, request.input, {
              parentToolCallId: params.parentToolCallId,
              signal: params.signal,
              onUpdate: params.onUpdate,
            });
            if (request.catalogId) {
              return called.result;
            }
            return isRecord(called.result) && "details" in called.result
              ? called.result.details
              : called.result;
          },
        );
        break;
      }
    }
    return { id: params.request.id, ok: true, value: toCodeModeJsonSafe(value) };
  } catch (error) {
    return { id: params.request.id, ok: false, error: errorMessage(error) };
  }
}

function resolveCodeModeWorkerUrl(currentModuleUrl: string): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const distMarker = `${path.sep}dist${path.sep}`;
  const distIndex = currentPath.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length - 1);
    return pathToFileURL(path.join(distRoot, "agents", "code-mode.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./code-mode.worker${extension}`, currentModuleUrl);
}

function codeModeWorkerUrl(): URL {
  return resolveCodeModeWorkerUrl(import.meta.url);
}

function failedCodeModeWorkerResult(
  error: unknown,
  code: CodeModeFailureCode,
): Extract<CodeModeWorkerResult, { status: "failed" }> {
  return {
    status: "failed",
    error: errorMessage(error),
    code,
    output: [],
  };
}

function normalizeCodeModeTimeoutResult<
  T extends { status: string; code?: unknown; error?: unknown },
>(result: T): T {
  if (
    result.status === "failed" &&
    result.code === "timeout" &&
    !String(result.error).includes("timeout exceeded")
  ) {
    return {
      ...result,
      error: "code mode timeout exceeded",
    } as T;
  }
  return result;
}

function normalizeCodeModeWorkerResult(result: CodeModeWorkerResult): CodeModeWorkerResult {
  return normalizeCodeModeTimeoutResult(result);
}

async function runCodeModeWorker(
  workerData: unknown,
  timeoutMs: number,
  workerUrl?: URL,
  signal?: AbortSignal,
): Promise<CodeModeWorkerResult> {
  const resolvedWorkerUrl = workerUrl ?? codeModeWorkerUrl();
  const sourceWorkerExecArgv = resolvedWorkerUrl.pathname.endsWith(".ts")
    ? ["--import", "tsx"]
    : undefined;
  let worker: Worker;
  try {
    worker = new Worker(resolvedWorkerUrl, {
      workerData,
      execArgv: sourceWorkerExecArgv,
    });
  } catch (error) {
    return failedCodeModeWorkerResult(error, "runtime_unavailable");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<CodeModeWorkerResult>((resolve) => {
      let settled = false;
      const finish = (result: CodeModeWorkerResult) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };
      timer = setTimeout(() => {
        void worker.terminate();
        finish({
          status: "failed",
          error: "code mode worker timeout exceeded",
          code: "timeout",
          output: [],
        });
      }, timeoutMs);
      onAbort = () => {
        void worker.terminate();
        const abortReason = signal?.reason;
        finish({
          status: "failed",
          error:
            abortReason instanceof CodeModeHeadlessTimeoutError
              ? "code mode timeout exceeded"
              : "code mode execution aborted",
          code: abortReason instanceof CodeModeHeadlessTimeoutError ? "timeout" : "aborted",
          output: [],
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
      worker.once("message", (message: unknown) => {
        void worker.terminate();
        const result = isRecord(message)
          ? (message as CodeModeWorkerResult)
          : ({
              status: "failed",
              error: "invalid code mode worker response",
              code: "internal_error",
              output: [],
            } satisfies CodeModeWorkerResult);
        finish(normalizeCodeModeWorkerResult(result));
      });
      worker.once("error", (error) => {
        finish(failedCodeModeWorkerResult(error, "runtime_unavailable"));
      });
      worker.once("exit", (code) => {
        if (code !== 0) {
          finish(
            failedCodeModeWorkerResult(
              new Error(`code mode worker exited with code ${code}`),
              "runtime_unavailable",
            ),
          );
        }
      });
    });
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export class CodeModeHeadlessAbortError extends Error {
  constructor(message = "code mode execution aborted") {
    super(message);
    this.name = "CodeModeHeadlessAbortError";
  }
}

export class CodeModeHeadlessTimeoutError extends Error {
  constructor(message = "code mode headless wall-clock timeout exceeded") {
    super(message);
    this.name = "CodeModeHeadlessTimeoutError";
  }
}

// Explicit return type: declaration emit cannot name the inferred AbortSignal
// in the DOM-free core lane (@types/node keeps it in a non-exported module).
function createHeadlessAbortScope(
  signal: AbortSignal | undefined,
  wallClockMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  const timer = setTimeout(() => controller.abort(new CodeModeHeadlessTimeoutError()), wallClockMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function headlessAbortError(
  signal: AbortSignal,
): CodeModeHeadlessAbortError | CodeModeHeadlessTimeoutError {
  return signal.reason instanceof CodeModeHeadlessTimeoutError
    ? signal.reason
    : signal.reason instanceof CodeModeHeadlessAbortError
      ? signal.reason
      : new CodeModeHeadlessAbortError();
}

function headlessFailure(params: {
  code: CodeModeFailureCode | "tool_budget_exceeded";
  error: string;
  output: unknown[];
  toolCallCount: number;
}): CodeModeHeadlessResult {
  return { status: "failed", ...params };
}

function remainingHeadlessMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new CodeModeHeadlessTimeoutError();
  }
  return remaining;
}

async function awaitHeadlessDeadline<T>(params: {
  promise: Promise<T>;
  deadline: number;
  signal?: AbortSignal;
}): Promise<T> {
  const remainingMs = remainingHeadlessMs(params.deadline);
  if (params.signal?.aborted) {
    throw headlessAbortError(params.signal);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CodeModeHeadlessTimeoutError()), remainingMs);
      const signal = params.signal;
      if (signal) {
        onAbort = () => reject(headlessAbortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return await Promise.race([params.promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (params.signal && onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function runHeadlessWorkerLeg(params: {
  input: Record<string, unknown>;
  config: CodeModeConfig;
  deadline: number;
  signal: AbortSignal;
}): Promise<CodeModeWorkerResult> {
  const remainingMs = remainingHeadlessMs(params.deadline);
  const timeoutMs = Math.max(1, Math.min(params.config.timeoutMs, remainingMs));
  const workerTimeoutMs = Math.max(1, Math.min(remainingMs, timeoutMs + 1000));
  return await runCodeModeWorker(
    {
      ...params.input,
      config: { ...params.config, timeoutMs },
    },
    workerTimeoutMs,
    undefined,
    params.signal,
  );
}

function normalizeHeadlessNamespaceValue(
  descriptor: SerializedCodeModeNamespaceValue,
): SerializedCodeModeNamespaceValue {
  if (descriptor.kind === "array") {
    return { kind: "array", items: descriptor.items.map(normalizeHeadlessNamespaceValue) };
  }
  if (descriptor.kind === "object") {
    return {
      kind: "object",
      entries: descriptor.entries.map(([key, value]) => {
        if (!key) {
          throw new ToolInputError("code mode namespace descriptor keys must not be empty");
        }
        return [key, normalizeHeadlessNamespaceValue(value)];
      }),
    };
  }
  if (descriptor.kind !== "value") {
    return descriptor;
  }
  return { kind: "value", value: toCodeModeJsonSafe(descriptor.value) };
}

function normalizeHeadlessNamespace(
  descriptor: CodeModeNamespaceDescriptor,
): CodeModeNamespaceDescriptor {
  return { ...descriptor, scope: normalizeHeadlessNamespaceValue(descriptor.scope) };
}

function mergeHeadlessNamespaces(
  registered: CodeModeNamespaceDescriptor[],
  extra: CodeModeNamespaceDescriptor[],
): CodeModeNamespaceDescriptor[] {
  const ids = new Set(registered.map((descriptor) => descriptor.id));
  const globalNames = new Set(registered.map((descriptor) => descriptor.globalName));
  const merged = [...registered];
  for (const descriptor of extra) {
    if (ids.has(descriptor.id) || globalNames.has(descriptor.globalName)) {
      throw new ToolInputError(
        `code mode namespace collision for ${descriptor.id} (${descriptor.globalName})`,
      );
    }
    ids.add(descriptor.id);
    globalNames.add(descriptor.globalName);
    merged.push(normalizeHeadlessNamespace(descriptor));
  }
  return merged;
}

function headlessNamespaceFreezePrelude(descriptors: CodeModeNamespaceDescriptor[]): string {
  const globalNames = JSON.stringify(descriptors.map((descriptor) => descriptor.globalName));
  return `;(() => {
    const seen = new WeakSet();
    const freeze = (value) => {
      if ((value === null || (typeof value !== "object" && typeof value !== "function")) || seen.has(value)) return value;
      seen.add(value);
      for (const key of Object.keys(value)) freeze(value[key]);
      return Object.freeze(value);
    };
    for (const name of ${globalNames}) freeze(globalThis[name]);
  })();\n`;
}

/** Run Code Mode to completion without publishing resumable snapshot state. */
export async function runCodeModeScriptHeadless(params: {
  ctx: ToolSearchToolContext;
  code: string;
  language?: "javascript" | "typescript";
  overrides?: Partial<
    Pick<
      CodeModeConfig,
      | "timeoutMs"
      | "memoryLimitBytes"
      | "maxOutputBytes"
      | "maxSnapshotBytes"
      | "maxPendingToolCalls"
    >
  >;
  wallClockMs?: number;
  maxToolCalls?: number;
  extraNamespaces?: CodeModeNamespaceDescriptor[];
  signal?: AbortSignal;
}): Promise<CodeModeHeadlessResult> {
  const config = resolveCodeModeHeadlessConfig(params.ctx, params.overrides);
  const wallClockMs = clampNumber(readPositiveInteger(params.wallClockMs, 30_000), 1, 300_000);
  const maxToolCalls = clampNumber(readPositiveInteger(params.maxToolCalls, 5), 1, 128);
  const deadline = Date.now() + wallClockMs;
  const abortScope = createHeadlessAbortScope(params.signal, wallClockMs);
  const output: unknown[] = [];
  let toolCallCount = 0;
  try {
    const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config));
    const catalog = runtime.all({ includeMcp: false });
    const namespaceCatalog = runtime.namespaceEntries();
    const namespaceRuntime = await awaitHeadlessDeadline({
      promise: createCodeModeNamespaceRuntime(params.ctx, namespaceCatalog),
      deadline,
      signal: abortScope.signal,
    });
    const preparedSource = await awaitHeadlessDeadline({
      promise: prepareSource({ code: params.code, language: params.language, config }),
      deadline,
      signal: abortScope.signal,
    });
    const namespaces = mergeHeadlessNamespaces(
      namespaceRuntime.descriptors,
      params.extraNamespaces ?? [],
    );
    const source = `${headlessNamespaceFreezePrelude(namespaces)}${preparedSource}`;
    const parentToolCallId = `headless:${randomUUID()}`;
    let result = normalizeCodeModeWorkerResult(
      await runHeadlessWorkerLeg({
        input: {
          kind: "exec",
          source,
          catalog,
          apiFiles: createCodeModeApiVirtualFiles(namespaceCatalog),
          namespaces,
        },
        config,
        deadline,
        signal: abortScope.signal,
      }),
    );

    while (true) {
      output.push(...result.output);
      enforceOutputLimit(output, config);
      if (result.status === "completed") {
        enforceResultLimit({ output, value: result.value, config });
        return { status: "completed", value: result.value, output, toolCallCount };
      }
      if (result.status === "failed") {
        return headlessFailure({
          code: result.code,
          error: result.error,
          output,
          toolCallCount,
        });
      }

      enforceSnapshotPayloadLimits({ snapshotBytes: result.snapshotBytes, config, output });
      const requestedToolCalls = result.pendingRequests.filter(
        (request) => request.method === "call" || request.method === "namespace",
      ).length;
      toolCallCount += requestedToolCalls;
      if (toolCallCount > maxToolCalls) {
        return headlessFailure({
          code: "tool_budget_exceeded",
          error: `code mode headless tool budget exceeded (${maxToolCalls})`,
          output,
          toolCallCount,
        });
      }

      const settledRequests = await awaitHeadlessDeadline({
        promise: Promise.all(
          result.pendingRequests.map((request) =>
            runBridgeRequest({
              runtime,
              namespaceRuntime,
              parentToolCallId,
              request,
              signal: abortScope.signal,
            }),
          ),
        ),
        deadline,
        signal: abortScope.signal,
      });
      result = normalizeCodeModeWorkerResult(
        await runHeadlessWorkerLeg({
          input: {
            kind: "resume",
            snapshotBytes: result.snapshotBytes,
            settledRequests,
          },
          config,
          deadline,
          signal: abortScope.signal,
        }),
      );
    }
  } catch (error) {
    const timedOut = error instanceof CodeModeHeadlessTimeoutError;
    const aborted = error instanceof CodeModeHeadlessAbortError;
    return headlessFailure({
      code: timedOut ? "timeout" : aborted ? "aborted" : codeModeFailureCode(error),
      error: timedOut || aborted ? error.message : codeModeFailureMessage(error),
      output,
      toolCallCount,
    });
  } finally {
    abortScope.cleanup();
  }
}

function snapshotState(params: {
  pendingRequests: PendingBridgeRequest[];
  snapshotBytes: Uint8Array;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: unknown[];
  replaySafe: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  enforceSnapshotStateLimits(params);
  return storeSnapshotState({
    ...params,
    pending: createPendingBridgeStates(params),
    replaySafe:
      params.replaySafe && pendingBridgeRequestsReplaySafe(params.pendingRequests, params.runtime),
  });
}

function pendingBridgeRequestsReplaySafe(
  pending: readonly PendingBridgeRequest[],
  runtime: ToolSearchRuntime,
): boolean {
  return pending.every((request) => {
    if (
      request.method === "search" ||
      request.method === "describe" ||
      request.method === "yield"
    ) {
      return true;
    }
    if (request.method !== "call") {
      return false;
    }
    const id = Array.isArray(request.args) ? request.args[0] : undefined;
    return typeof id === "string" && runtime.isReplaySafeExactId(id);
  });
}

function enforceSnapshotStateLimits(params: {
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
  output: unknown[];
}) {
  enforceActiveRunLimit();
  enforceSnapshotPayloadLimits(params);
}

function enforceSnapshotPayloadLimits(params: {
  snapshotBytes: Uint8Array;
  config: CodeModeConfig;
  output: unknown[];
}) {
  if (params.snapshotBytes.byteLength > params.config.maxSnapshotBytes) {
    throw new CodeModeLimitError("snapshot_limit_exceeded", "code mode snapshot limit exceeded");
  }
  enforceOutputLimit(params.output, params.config);
}

function createPendingBridgeStates(params: {
  pendingRequests: PendingBridgeRequest[];
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  parentToolCallId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): PendingBridgeState[] {
  return params.pendingRequests.map((request) => {
    // Bridge calls start immediately while the VM snapshot is stored. Their
    // settled values are later replayed into QuickJS by the wait tool.
    const promise = runBridgeRequest({
      runtime: params.runtime,
      namespaceRuntime: params.namespaceRuntime,
      parentToolCallId: params.parentToolCallId,
      request,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
    const state: PendingBridgeState = { ...request, promise };
    void promise.then((settled) => {
      state.settled = settled;
    });
    return state;
  });
}

function storeSnapshotState(params: {
  pending: PendingBridgeState[];
  replaySafe: boolean;
  snapshotBytes: Uint8Array;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  output: unknown[];
}) {
  const runId = `cm_${randomUUID()}`;
  const now = Date.now();
  const expiresAt = resolveCodeModeSnapshotExpiresAt(now, params.config.snapshotTtlSeconds);
  if (expiresAt === undefined) {
    throw new ToolInputError("code mode run expiry is unavailable.");
  }
  activeRuns.set(runId, {
    runId,
    parentToolCallId: params.parentToolCallId,
    ctx: params.ctx,
    config: params.config,
    snapshotBytes: params.snapshotBytes,
    pending: params.pending,
    replaySafe: params.replaySafe,
    output: params.output,
    createdAt: now,
    expiresAt,
    runtime: params.runtime,
    namespaceRuntime: params.namespaceRuntime,
  });
  return {
    status: "waiting" as const,
    runId,
    reason: codeModeWaitingReason(params.pending),
    pendingToolCalls: pendingToolCalls(params.pending),
    replaySafe: params.replaySafe,
    output: params.output,
    telemetry: telemetry(params.runtime),
  };
}

function codeModeWaitingReason(pending: readonly PendingBridgeState[]): "pending_tools" | "yield" {
  return pending.length > 0 && pending.every((entry) => entry.method === "yield")
    ? "yield"
    : "pending_tools";
}

function pendingToolCalls(pending: readonly PendingBridgeState[]) {
  return pending.map((entry) => ({ id: entry.id, method: entry.method }));
}

function telemetry(runtime: ToolSearchRuntime) {
  return {
    ...runtime.telemetry(),
    visibleTools: [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME],
  };
}

function createCodeModeExecDescription(
  ctx: CodeModeToolContext,
  catalog?: readonly ToolSearchCatalogEntry[],
): string {
  const namespacePrompt = describeCodeModeNamespacesForPrompt(ctx, catalog);
  return (
    'Run JavaScript or TypeScript in OpenClaw code mode. Use `return` to pass the final value back to the agent; awaited calls without a returned value complete as `null`. Node.js modules and `require`/`import` are NOT available; for any shell, file, network, or external action, use enabled catalog tools allowed by policy from inside your code: `tools.search(query)` to find catalog entries, `tools.describe(entry.id)` for the input schema, then `tools.call(entry.id, args)`. Read TypeScript-style declaration files with `API.list(prefix?)` and `API.read(path)`. MCP tools are available only through the `MCP` namespace. Registered plugin namespaces are available as direct globals and through `namespaces` when their required tools are visible in the run catalog. The `language` field accepts only "javascript" or "typescript"; do not pass "bash", "shell", or other values.' +
    (namespacePrompt ? `\n\n${namespacePrompt}` : "")
  );
}

async function runExec(params: {
  toolCallId: string;
  ctx: CodeModeToolContext;
  code: string;
  language?: CodeModeLanguage;
  restartSafe: boolean;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  removeExpiredRuns();
  const config = resolveCodeModeConfig(
    params.ctx.runtimeConfig ?? params.ctx.config,
    params.ctx.agentId,
  );
  if (!config.enabled) {
    throw new ToolInputError("code mode is disabled.");
  }
  const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config));
  const catalog = runtime.all({ includeMcp: false });
  const namespaceCatalog = runtime.namespaceEntries();
  const namespaceRuntime = await createCodeModeNamespaceRuntime(params.ctx, namespaceCatalog);
  const apiFiles = createCodeModeApiVirtualFiles(namespaceCatalog);
  let source: string;
  try {
    source = await prepareSource({ code: params.code, language: params.language, config });
  } catch (error) {
    return {
      status: "failed" as const,
      error: codeModeFailureMessage(error),
      code: codeModeFailureCode(error),
      output: [],
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  }
  try {
    const result = normalizeCodeModeWorkerResult(
      await runCodeModeWorker(
        {
          kind: "exec",
          source,
          config,
          catalog,
          apiFiles,
          namespaces: namespaceRuntime.descriptors,
        },
        config.timeoutMs + 1000,
      ),
    );
    return await settleCodeModeResult({
      result,
      output: result.output,
      replaySafe: params.restartSafe,
      parentToolCallId: params.toolCallId,
      ctx: params.ctx,
      config,
      runtime,
      namespaceRuntime,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  } catch (error) {
    return {
      status: "failed" as const,
      error: codeModeFailureMessage(error),
      code: codeModeFailureCode(error),
      output: [],
      replaySafe: params.restartSafe,
      telemetry: telemetry(runtime),
    };
  }
}

async function waitForPending(pending: PendingBridgeState[], timeoutMs: number): Promise<boolean> {
  const pendingPromises = pending.filter((entry) => !entry.settled).map((entry) => entry.promise);
  if (pendingPromises.length === 0) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(pendingPromises).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function settleCodeModeResult(params: {
  result: CodeModeWorkerResult;
  output: unknown[];
  replaySafe: boolean;
  parentToolCallId: string;
  ctx: ToolSearchToolContext;
  config: CodeModeConfig;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  let result = params.result;
  const output = params.output;
  let namespaceRounds = 0;
  const settleDeadline = Date.now() + params.config.timeoutMs;
  // Namespace calls are trusted synchronous-looking plugin helpers. Resolve
  // them inline when possible so the model avoids unnecessary wait turns.
  while (
    result.status === "waiting" &&
    result.pendingRequests.length > 0 &&
    result.pendingRequests.every((request) => request.method === "namespace") &&
    namespaceRounds < params.config.maxPendingToolCalls
  ) {
    if (params.replaySafe) {
      return {
        status: "failed" as const,
        error: "restart-safe code mode cannot call plugin namespaces.",
        code: "invalid_input" as const,
        output,
        replaySafe: true,
        telemetry: telemetry(params.runtime),
      };
    }
    const remainingMs = settleDeadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    enforceSnapshotPayloadLimits({
      snapshotBytes: result.snapshotBytes,
      config: params.config,
      output,
    });
    const releaseReservation = reserveActiveRunSlot();
    try {
      const pending = createPendingBridgeStates({
        pendingRequests: result.pendingRequests,
        runtime: params.runtime,
        namespaceRuntime: params.namespaceRuntime,
        parentToolCallId: params.parentToolCallId,
        signal: params.signal,
        onUpdate: params.onUpdate,
      });
      const ready = await waitForPending(pending, remainingMs);
      if (!ready) {
        return storeSnapshotState({
          pending,
          replaySafe: false,
          snapshotBytes: result.snapshotBytes,
          parentToolCallId: params.parentToolCallId,
          ctx: params.ctx,
          config: params.config,
          runtime: params.runtime,
          namespaceRuntime: params.namespaceRuntime,
          output,
        });
      }
      const settledRequests: SettledBridgeRequest[] = [];
      for (const entry of pending) {
        settledRequests.push(entry.settled ?? (await entry.promise));
      }
      result = normalizeCodeModeWorkerResult(
        await runCodeModeWorker(
          {
            kind: "resume",
            snapshotBytes: result.snapshotBytes,
            config: params.config,
            settledRequests,
          },
          Math.max(1, settleDeadline - Date.now()) + 1000,
        ),
      );
    } finally {
      releaseReservation();
    }
    output.push(...result.output);
    enforceOutputLimit(output, params.config);
    namespaceRounds += 1;
  }
  if (result.status === "waiting") {
    const pendingReplaySafe = pendingBridgeRequestsReplaySafe(
      result.pendingRequests,
      params.runtime,
    );
    if (params.replaySafe && !pendingReplaySafe) {
      return {
        status: "failed" as const,
        error: "restart-safe code mode cannot call side-effecting tools.",
        code: "invalid_input" as const,
        output,
        replaySafe: true,
        telemetry: telemetry(params.runtime),
      };
    }
    return snapshotState({
      pendingRequests: result.pendingRequests,
      snapshotBytes: result.snapshotBytes,
      parentToolCallId: params.parentToolCallId,
      ctx: params.ctx,
      config: params.config,
      runtime: params.runtime,
      namespaceRuntime: params.namespaceRuntime,
      output,
      replaySafe: params.replaySafe,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  }
  enforceResultLimit({
    output,
    value: result.status === "completed" ? result.value : undefined,
    config: params.config,
  });
  return {
    ...result,
    output,
    replaySafe: params.replaySafe,
    telemetry: telemetry(params.runtime),
  };
}

async function runWait(params: {
  toolCallId: string;
  ctx: CodeModeToolContext;
  runId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  removeExpiredRuns();
  const state = activeRuns.get(params.runId);
  if (!state) {
    throw new ToolInputError("code mode run is unavailable or expired.");
  }
  if (state.ctx.runId && params.ctx.runId && state.ctx.runId !== params.ctx.runId) {
    throw new ToolInputError("code mode run belongs to a different agent run.");
  }
  if (
    (state.ctx.sessionId && params.ctx.sessionId && state.ctx.sessionId !== params.ctx.sessionId) ||
    (state.ctx.sessionKey &&
      params.ctx.sessionKey &&
      state.ctx.sessionKey !== params.ctx.sessionKey) ||
    (state.ctx.agentId && params.ctx.agentId && state.ctx.agentId !== params.ctx.agentId)
  ) {
    throw new ToolInputError("code mode run belongs to a different session.");
  }
  if (resumingRunIds.has(state.runId)) {
    throw new ToolInputError("code mode run is already being resumed.");
  }
  resumingRunIds.add(state.runId);
  try {
    const ready = await waitForPending(state.pending, state.config.timeoutMs);
    if (!ready) {
      const pending = state.pending.filter((entry) => !entry.settled);
      return {
        status: "waiting" as const,
        runId: state.runId,
        reason: codeModeWaitingReason(pending.length > 0 ? pending : state.pending),
        pendingToolCalls: pendingToolCalls(pending.length > 0 ? pending : state.pending),
        replaySafe: state.replaySafe,
        output: state.output,
        telemetry: telemetry(state.runtime),
      };
    }

    activeRuns.delete(state.runId);
    const settledRequests: SettledBridgeRequest[] = [];
    for (const entry of state.pending) {
      settledRequests.push(entry.settled ?? (await entry.promise));
    }
    const result = normalizeCodeModeWorkerResult(
      await runCodeModeWorker(
        {
          kind: "resume",
          snapshotBytes: state.snapshotBytes,
          config: state.config,
          settledRequests,
        },
        state.config.timeoutMs + 1000,
      ),
    );
    const output = [...state.output, ...result.output];
    enforceOutputLimit(output, state.config);
    return await settleCodeModeResult({
      result,
      output,
      replaySafe: state.replaySafe,
      parentToolCallId: params.toolCallId,
      ctx: state.ctx,
      config: state.config,
      runtime: state.runtime,
      namespaceRuntime: state.namespaceRuntime,
      signal: params.signal,
      onUpdate: params.onUpdate,
    });
  } catch (error) {
    return {
      status: "failed" as const,
      error: codeModeFailureMessage(error),
      code: codeModeFailureCode(error),
      output: state.output,
      replaySafe: state.replaySafe,
      telemetry: telemetry(state.runtime),
    };
  } finally {
    resumingRunIds.delete(state.runId);
  }
}

/** Create the exec/wait control tools for one Code Mode run context. */
export function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[] {
  const execTool = markCodeModeControlTool({
    name: CODE_MODE_EXEC_TOOL_NAME,
    label: "exec",
    description: createCodeModeExecDescription(ctx),
    parameters: Type.Object({
      code: Type.Optional(
        Type.String({
          description:
            "JavaScript or TypeScript source to run. The `tools` object (search/describe/call), `ALL_TOOLS`, `API` virtual declaration files, and registered namespace globals are available in scope; Node built-in modules are not.",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description: "Alias for code, provided for exec-compatible hook policies.",
        }),
      ),
      language: optionalStringEnum(["javascript", "typescript"] as const, {
        description:
          'Source language. Must be "javascript" or "typescript". Defaults to javascript.',
      }),
      restartSafe: Type.Optional(
        Type.Boolean({
          description:
            "Set true for read-only work that OpenClaw may reconstruct after a gateway restart. This rejects side-effecting catalog tools and plugin namespaces.",
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      const input = readCode(args);
      return jsonResult(
        normalizeCodeModeTimeoutResult(
          await runExec({
            toolCallId,
            ctx,
            code: input.code,
            language: input.language,
            restartSafe: ctx.forceRestartSafeTools === true || input.restartSafe,
            signal,
            onUpdate,
          }),
        ),
      );
    },
  } as AnyAgentTool);
  const waitTool = markCodeModeControlTool({
    name: CODE_MODE_WAIT_TOOL_NAME,
    label: "wait",
    hideFromChannelProgress: true,
    description: "Resume a suspended OpenClaw code mode run returned by exec.",
    parameters: Type.Object({
      runId: Type.String({ description: "Code mode run id returned by exec." }),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) =>
      jsonResult(
        normalizeCodeModeTimeoutResult(
          await runWait({
            toolCallId,
            ctx,
            runId: readRunId(args),
            signal,
            onUpdate,
          }),
        ),
      ),
  } as AnyAgentTool);
  return [execTool, waitTool];
}

/** Compact normal tools behind Code Mode exec/wait controls. */
export function applyCodeModeCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
}) {
  const config = resolveCodeModeConfig(params.config, params.agentId);
  if (!config.enabled) {
    return applyToolCatalogCompaction({
      ...params,
      enabled: false,
      isVisibleControlTool: isCodeModeControlTool,
    });
  }
  const tools = params.tools.filter(
    (tool) =>
      isCodeModeControlTool(tool) ||
      (tool.name !== TOOL_SEARCH_CODE_MODE_TOOL_NAME &&
        tool.name !== TOOL_SEARCH_RAW_TOOL_NAME &&
        tool.name !== TOOL_DESCRIBE_RAW_TOOL_NAME &&
        tool.name !== TOOL_CALL_RAW_TOOL_NAME),
  );
  const compacted = applyToolCatalogCompaction({
    ...params,
    tools,
    enabled: true,
    isVisibleControlTool: isCodeModeControlTool,
    shouldCatalogTool: (tool) => !isCodeModeControlTool(tool),
  });
  const visibleCatalog = params.catalogRef?.current?.entries ?? [];
  for (const tool of compacted.tools) {
    if (tool.name === CODE_MODE_EXEC_TOOL_NAME) {
      tool.description = createCodeModeExecDescription(
        {
          config: params.config,
          runtimeConfig: params.config,
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          catalogRef: params.catalogRef,
        },
        visibleCatalog,
      );
    }
  }
  return compacted;
}

/** Move client-side tool definitions into the active Code Mode catalog. */
export function addClientToolsToCodeModeCatalog(params: {
  tools: ToolDefinition[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}) {
  return addClientToolsToToolCatalog({
    ...params,
    enabled: resolveCodeModeConfig(params.config, params.agentId).enabled,
  });
}

/** Test-only hooks and state accessors for Code Mode worker orchestration. */
export const testing = {
  activeRuns,
  resumingRunIds,
  codeModeWorkerUrl,
  createHeadlessAbortScope,
  normalizeCodeModeWorkerResult,
  runCodeModeWorker,
  resolveCodeModeHeadlessConfig,
  resolveCodeModeWorkerUrl,
  resolveCodeModeConfig,
  getTypescriptRuntimePromise: (): Promise<typeof import("typescript")> | null =>
    typescriptRuntimeLoader.peek() ?? null,
  setTypescriptRuntimeForTest: (runtime: typeof import("typescript") | null) => {
    typescriptRuntimeForTest = runtime;
  },
};
