import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
import { optionalStringEnum } from "./schema/typebox.js";
import {
  addClientToolsToToolCatalog,
  applyToolCatalogCompaction,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  ToolSearchRuntime,
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

export const CODE_MODE_EXEC_TOOL_NAME = "exec";
export const CODE_MODE_WAIT_TOOL_NAME = "wait";

const codeModeControlTools = new WeakSet<AnyAgentTool>();

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

type CodeModeBridgeMethod = "search" | "describe" | "call" | "yield";

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
};

type CodeModeToolContext = ToolSearchToolContext;

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
      code: "invalid_input" | "internal_error";
      output: unknown[];
    };

const activeRuns = new Map<string, CodeModeRunState>();
const resumingRunIds = new Set<string>();
let typescriptRuntimePromise: Promise<typeof import("typescript")> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readCodeModeRawConfig(config?: OpenClawConfig): Record<string, unknown> {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  const codeMode = tools?.codeMode;
  if (codeMode === true) {
    return { enabled: true };
  }
  if (codeMode === false) {
    return { enabled: false };
  }
  return isRecord(codeMode) ? codeMode : {};
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
  return languages.length > 0 ? [...new Set(languages)] : ["javascript", "typescript"];
}

export function resolveCodeModeConfig(config?: OpenClawConfig): CodeModeConfig {
  const raw = readCodeModeRawConfig(config);
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

export function isCodeModeControlTool(tool: AnyAgentTool): boolean {
  return codeModeControlTools.has(tool);
}

function markCodeModeControlTool<T extends AnyAgentTool>(tool: T): T {
  codeModeControlTools.add(tool);
  return tool;
}

function removeExpiredRuns(now = Date.now()): void {
  for (const [runId, state] of activeRuns) {
    if (state.expiresAt <= now) {
      activeRuns.delete(runId);
      resumingRunIds.delete(runId);
    }
  }
}

function enforceActiveRunLimit(): void {
  removeExpiredRuns();
  if (activeRuns.size >= MAX_ACTIVE_CODE_MODE_RUNS) {
    throw new ToolInputError("too many suspended code mode runs.");
  }
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
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

function enforceOutputLimit(output: unknown[], config: CodeModeConfig): void {
  if (jsonByteLength(output) > config.maxOutputBytes) {
    throw new ToolInputError("code mode output limit exceeded");
  }
}

function enforceResultLimit(params: {
  output: unknown[];
  value?: unknown;
  config: CodeModeConfig;
}): void {
  enforceOutputLimit(params.output, params.config);
  if (params.value !== undefined && jsonByteLength(params.value) > params.config.maxOutputBytes) {
    throw new ToolInputError("code mode output limit exceeded");
  }
}

function readCode(args: unknown): { code: string; language?: CodeModeLanguage } {
  const params = asToolParamsRecord(args);
  const code = params.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new ToolInputError("code must be a non-empty string.");
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
  parentToolCallId: string;
  request: PendingBridgeRequest;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
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
        });
        break;
      }
      case "describe": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("describe id must be a string.");
        }
        value = await params.runtime.describe(id);
        break;
      }
      case "call": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("call id must be a string.");
        }
        value = await params.runtime.call(id, values[1] ?? {}, {
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

async function runCodeModeWorker(
  workerData: unknown,
  timeoutMs: number,
): Promise<CodeModeWorkerResult> {
  const worker = new Worker(codeModeWorkerUrl(), {
    workerData,
  });
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
          code: "internal_error",
          output: [],
        });
      }, timeoutMs);
      worker.once("message", (message: unknown) => {
        void worker.terminate();
        finish(
          isRecord(message)
            ? (message as CodeModeWorkerResult)
            : {
                status: "failed",
                error: "invalid code mode worker response",
                code: "internal_error",
                output: [],
              },
        );
      });
      worker.once("error", (error) => {
        finish({
          status: "failed",
          error: errorMessage(error),
          code: "internal_error",
          output: [],
        });
      });
      worker.once("exit", (code) => {
        if (code !== 0) {
          finish({
            status: "failed",
            error: `code mode worker exited with code ${code}`,
            code: "internal_error",
            output: [],
          });
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
  output: unknown[];
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
}) {
  enforceActiveRunLimit();
  if (params.snapshotBytes.byteLength > params.config.maxSnapshotBytes) {
    throw new ToolInputError("code mode snapshot limit exceeded");
  }
  enforceOutputLimit(params.output, params.config);
  const runId = `cm_${randomUUID()}`;
  const pending = params.pendingRequests.map((request) => {
    const promise = runBridgeRequest({
      runtime: params.runtime,
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
  const now = Date.now();
  activeRuns.set(runId, {
    runId,
    parentToolCallId: params.parentToolCallId,
    ctx: params.ctx,
    config: params.config,
    snapshotBytes: params.snapshotBytes,
    pending,
    output: params.output,
    createdAt: now,
    expiresAt: now + params.config.snapshotTtlSeconds * 1000,
    runtime: params.runtime,
  });
  return {
    status: "waiting" as const,
    runId,
    reason: codeModeWaitingReason(pending),
    pendingToolCalls: pendingToolCalls(pending),
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

async function runExec(params: {
  toolCallId: string;
  ctx: CodeModeToolContext;
  code: string;
  language?: CodeModeLanguage;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
}) {
  removeExpiredRuns();
  const config = resolveCodeModeConfig(params.ctx.runtimeConfig ?? params.ctx.config);
  if (!config.enabled) {
    throw new ToolInputError("code mode is disabled.");
  }
  const runtime = new ToolSearchRuntime(params.ctx, toToolSearchConfig(config));
  let source: string;
  try {
    source = await prepareSource({ code: params.code, language: params.language, config });
  } catch (error) {
    return {
      status: "failed" as const,
      error: errorMessage(error),
      code: error instanceof ToolInputError ? "invalid_input" : "internal_error",
      output: [],
      telemetry: telemetry(runtime),
    };
  }
  try {
    const result = await runCodeModeWorker(
      {
        kind: "exec",
        source,
        config,
        catalog: runtime.all(),
      },
      config.timeoutMs + 1000,
    );
    if (result.status === "waiting") {
      return snapshotState({
        pendingRequests: result.pendingRequests,
        snapshotBytes: result.snapshotBytes,
        parentToolCallId: params.toolCallId,
        ctx: params.ctx,
        config,
        runtime,
        output: result.output,
        signal: params.signal,
        onUpdate: params.onUpdate,
      });
    }
    enforceResultLimit({
      output: result.output,
      value: result.status === "completed" ? result.value : undefined,
      config,
    });
    return {
      ...result,
      telemetry: telemetry(runtime),
    };
  } catch (error) {
    return {
      status: "failed" as const,
      error: errorMessage(error),
      code: error instanceof ToolInputError ? "invalid_input" : "internal_error",
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

async function runWait(params: {
  toolCallId: string;
  ctx: CodeModeToolContext;
  runId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
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
    const result = await runCodeModeWorker(
      {
        kind: "resume",
        snapshotBytes: state.snapshotBytes,
        config: state.config,
        settledRequests,
      },
      state.config.timeoutMs + 1000,
    );
    const output = [...state.output, ...result.output];
    enforceOutputLimit(output, state.config);
    if (result.status === "waiting") {
      return snapshotState({
        pendingRequests: result.pendingRequests,
        snapshotBytes: result.snapshotBytes,
        parentToolCallId: params.toolCallId,
        ctx: state.ctx,
        config: state.config,
        runtime: state.runtime,
        output,
        signal: params.signal,
        onUpdate: params.onUpdate,
      });
    }
    enforceResultLimit({
      output,
      value: result.status === "completed" ? result.value : undefined,
      config: state.config,
    });
    return {
      ...result,
      output,
      telemetry: telemetry(state.runtime),
    };
  } catch (error) {
    return {
      status: "failed" as const,
      error: errorMessage(error),
      code: error instanceof ToolInputError ? "invalid_input" : "internal_error",
      output: state.output,
      telemetry: telemetry(state.runtime),
    };
  } finally {
    resumingRunIds.delete(state.runId);
  }
}

export function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[] {
  const execTool = markCodeModeControlTool({
    name: CODE_MODE_EXEC_TOOL_NAME,
    label: "exec",
    description:
      "Run JavaScript or TypeScript in OpenClaw code mode. Use ALL_TOOLS and tools.search/describe/call inside the code to discover and call enabled tools.",
    parameters: Type.Object({
      code: Type.String({ description: "JavaScript or TypeScript source to run." }),
      language: optionalStringEnum(["javascript", "typescript"] as const, {
        description: "Source language. Defaults to javascript.",
      }),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
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
      onUpdate?: AgentToolUpdateCallback<unknown>,
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
  const config = resolveCodeModeConfig(params.config);
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
  return applyToolCatalogCompaction({
    ...params,
    tools,
    enabled: true,
    isVisibleControlTool: isCodeModeControlTool,
    shouldCatalogTool: (tool) => !isCodeModeControlTool(tool),
  });
}

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
    enabled: resolveCodeModeConfig(params.config).enabled,
  });
}

export const __testing = {
  activeRuns,
  resumingRunIds,
  codeModeWorkerUrl,
  resolveCodeModeWorkerUrl,
  resolveCodeModeConfig,
  getTypescriptRuntimePromise: () => typescriptRuntimePromise,
};
