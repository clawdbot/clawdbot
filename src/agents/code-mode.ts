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
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeControlTool,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import {
  createCodeModeApiVirtualFiles,
  createCodeModeNamespaceRuntime,
  describeCodeModeNamespacesForPrompt,
  type CodeModeNamespaceRuntime,
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

type SettledBridgeRequest = {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

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
  output: unknown[];
  createdAt: number;
  expiresAt: number;
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
};

type CodeModeToolContext = ToolSearchToolContext;

type CodeModeFailureCode =
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error";

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
let typescriptRuntimePromise: Promise<typeof import("typescript")> | null = null;
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

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  const maxSearchLimit = clampInteger(
    readPositiveInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT),
    1,
    DEFAULT_MAX_SEARCH_LIMIT,
  );
  return {
    enabled: readBoolean(raw.enabled, false),
    runtime: "quickjs-wasi",
    mode: "only",
    languages: readLanguages(raw.languages),
    timeoutMs: clampInteger(readPositiveInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS), 100, 60_000),
    memoryLimitBytes: clampInteger(
      readPositiveInteger(raw.memoryLimitBytes, DEFAULT_MEMORY_LIMIT_BYTES),
      1024 * 1024,
      1024 * 1024 * 1024,
    ),
    maxOutputBytes: clampInteger(
      readPositiveInteger(raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      1024,
      10 * 1024 * 1024,
    ),
    maxSnapshotBytes: clampInteger(
      readPositiveInteger(raw.maxSnapshotBytes, DEFAULT_MAX_SNAPSHOT_BYTES),
      1024,
      256 * 1024 * 1024,
    ),
    maxPendingToolCalls: clampInteger(
      readPositiveInteger(raw.maxPendingToolCalls, DEFAULT_MAX_PENDING_TOOL_CALLS),
      1,
      128,
    ),
    snapshotTtlSeconds: clampInteger(
      readPositiveInteger(raw.snapshotTtlSeconds, DEFAULT_SNAPSHOT_TTL_SECONDS),
      1,
      24 * 60 * 60,
    ),
    searchDefaultLimit: clampInteger(
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

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
  } catch {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
        return value;
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(toJsonSafe(value)) ?? "null", "utf8");
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

function codeModeFailureCode(error: unknown): CodeModeFailureCode {
  if (error instanceof CodeModeLimitError) {
    return error.code;
  }
  return error instanceof ToolInputError ? "invalid_input" : "internal_error";
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

function readCode(args: unknown): { code: string; language?: CodeModeLanguage } {
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
  return { code, language };
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
  typescriptRuntimePromise ??= import("typescript");
  return await typescriptRuntimePromise;
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
        value = await params.runtime.describe(id, { includeMcp: false });
        break;
      }
      case "call": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("call id must be a string.");
        }
        const described = await params.runtime.describe(id, { includeMcp: false });
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
    return { id: params.request.id, ok: true, value: toJsonSafe(value) };
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

function isQuickJsInterruptedWorkerError(error: unknown): boolean {
  return String(error) === "interrupted";
}

function normalizeCodeModeWorkerResult(result: CodeModeWorkerResult): CodeModeWorkerResult {
  if (
    result.status === "failed" &&
    result.code === "timeout" &&
    isQuickJsInterruptedWorkerError(result.error)
  ) {
    return {
      ...result,
      error: "code mode timeout exceeded",
    };
  }
  return result;
}

async function runCodeModeWorker(
  workerData: unknown,
  timeoutMs: number,
  workerUrl?: URL,
): Promise<CodeModeWorkerResult> {
  let worker: Worker;
  try {
    worker = new Worker(workerUrl ?? codeModeWorkerUrl(), {
      workerData,
    });
  } catch (error) {
    return failedCodeModeWorkerResult(error, "runtime_unavailable");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
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
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  enforceSnapshotStateLimits(params);
  return storeSnapshotState({
    ...params,
    pending: createPendingBridgeStates(params),
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
      error: errorMessage(error),
      code: codeModeFailureCode(error),
      output: [],
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
      error: errorMessage(error),
      code: codeModeFailureCode(error),
      output: [],
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
    return snapshotState({
      pendingRequests: result.pendingRequests,
      snapshotBytes: result.snapshotBytes,
      parentToolCallId: params.parentToolCallId,
      ctx: params.ctx,
      config: params.config,
      runtime: params.runtime,
      namespaceRuntime: params.namespaceRuntime,
      output,
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
      error: errorMessage(error),
      code: codeModeFailureCode(error),
      output: state.output,
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
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      const input = readCode(args);
      return jsonResult(
        await runExec({
          toolCallId,
          ctx,
          code: input.code,
          language: input.language,
          signal,
          onUpdate,
        }),
      );
    },
  } as AnyAgentTool);
  const waitTool = markCodeModeControlTool({
    name: CODE_MODE_WAIT_TOOL_NAME,
    label: "wait",
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
        await runWait({
          toolCallId,
          ctx,
          runId: readRunId(args),
          signal,
          onUpdate,
        }),
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
  normalizeCodeModeWorkerResult,
  runCodeModeWorker,
  resolveCodeModeWorkerUrl,
  resolveCodeModeConfig,
  getTypescriptRuntimePromise: () => typescriptRuntimePromise,
  setTypescriptRuntimeForTest: (runtime: typeof import("typescript") | null) => {
    typescriptRuntimeForTest = runtime;
  },
};
export { testing as __testing };
